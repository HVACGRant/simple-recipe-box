const {onCall, HttpsError} = require("firebase-functions/v2/https");
const {defineSecret} = require("firebase-functions/params");
const admin = require("firebase-admin");

admin.initializeApp();

const anthropicApiKey = defineSecret("ANTHROPIC_API_KEY");

// ---- Protection settings -------------------------------------------------
// Scans each household can do per day (resets at midnight Pacific).
const DAILY_SCANS_PER_HOUSEHOLD = 30;
// Biggest photo we'll accept (the app shrinks photos to well under this).
const MAX_IMAGE_BASE64_CHARS = 6 * 1024 * 1024;
const ALLOWED_TYPES = ["image/jpeg", "image/png", "image/webp", "image/gif"];

function todayPacific() {
  // YYYY-MM-DD in Pacific time, so the limit resets at local midnight.
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Los_Angeles", year: "numeric", month: "2-digit", day: "2-digit",
  }).format(new Date());
}

exports.scanRecipe = onCall(
  {secrets: [anthropicApiKey], timeoutSeconds: 60, memory: "512MiB", maxInstances: 3},
  async (request) => {
    if (!request.auth) {
      throw new HttpsError("unauthenticated", "You must be signed in to scan a recipe.");
    }
    const uid = request.auth.uid;

    // 1) Only people who belong to a household can scan.
    const db = admin.database();
    const hid = (await db.ref("users/" + uid + "/household").once("value")).val();
    if (!hid) {
      throw new HttpsError("permission-denied", "Join or create a household before scanning recipes.");
    }
    const isMember = (await db.ref("households/" + hid + "/members/" + uid).once("value")).exists();
    if (!isMember) {
      throw new HttpsError("permission-denied", "You're not a member of that household anymore.");
    }

    // 2) Check the photo before spending anything on it.
    const {imageBase64, mimeType} = request.data || {};
    if (!imageBase64 || typeof imageBase64 !== "string") {
      throw new HttpsError("invalid-argument", "No image was provided.");
    }
    if (imageBase64.length > MAX_IMAGE_BASE64_CHARS) {
      throw new HttpsError("invalid-argument", "That photo is too large. Try a smaller one.");
    }
    const mediaType = ALLOWED_TYPES.includes(mimeType) ? mimeType : "image/jpeg";

    // 3) Daily limit per household (counted before the API call so it can't be bypassed).
    const usageRef = db.ref("scanUsage/" + hid + "/" + todayPacific());
    const result = await usageRef.transaction((n) => {
      const count = n || 0;
      if (count >= DAILY_SCANS_PER_HOUSEHOLD) return; // abort: limit reached
      return count + 1;
    });
    if (!result.committed) {
      throw new HttpsError("resource-exhausted",
        "Your household has used all " + DAILY_SCANS_PER_HOUSEHOLD + " scans for today. Try again tomorrow, or type the recipe in.");
    }

    const prompt = "You are extracting a recipe from a photo. It may be handwritten or printed, and may be angled or imperfectly lit - do your best.\n" +
      "Return ONLY valid JSON, with no markdown code fences and no commentary, in exactly this shape:\n" +
      "{\n" +
      "  \"name\": \"string\",\n" +
      "  \"servings\": number,\n" +
      "  \"ingredients\": [{\"name\": \"string\", \"amount\": \"string\", \"unit\": \"string\"}],\n" +
      "  \"steps\": [\"string\", ...]\n" +
      "}\n" +
      "IMPORTANT: \"amount\" is a STRING field, not a number. Always write it exactly the way the recipe shows it.\n" +
      "Rules for ingredients:\n" +
      "- Pay especially close attention to the amounts and units next to each ingredient - these are often small handwritten numbers or abbreviations. Look carefully before deciding a number is unclear.\n" +
      "- Keep fractions as fractions, written the normal way: \"1/2\", \"1/4\", \"1 1/2\". Do NOT convert them to decimals.\n" +
      "- If the recipe gives a range (e.g. \"1/8 to 1/4 teaspoon\" or \"6 to 8 ounces\"), keep the full range as the amount/unit text exactly as written - do NOT average it into a single number. Example: amount \"1/8 to 1/4\", not \"0.1875\".\n" +
      "- Use short, common cooking abbreviations for units: tsp, tbsp, c, oz, lb, g, kg, ml, l, pinch, clove(s), slice(s), can(s), stick(s), head(s), bunch(es), jar, package. Prefer these abbreviations over spelling the word out, to save space.\n" +
      "- Only leave amount as an empty string \"\" when the ingredient genuinely has no quantity written at all (e.g. \"salt to taste\", \"garnish\", \"for serving\").\n" +
      "- Never shrink an ingredient down to just its generic noun. Keep every descriptive word the recipe gives you - cut, size, brand, prep note, or a per-item weight range - inside \"name\", even if that makes the name long. \"amount\" and \"unit\" should only hold the leading count/measurement; everything else about that ingredient belongs in \"name\".\n" +
      "  Example: the written line \"4 boneless sirloin steaks, 6 to 8 ounces each\" should become {\"name\": \"boneless sirloin steaks, 6 to 8 oz each\", \"amount\": \"4\", \"unit\": \"\"} - NOT {\"name\": \"steak\", \"amount\": \"4\", \"unit\": \"\"}, and NOT putting that detail into \"unit\".\n" +
      "- Many recipe cards lay ingredients out in a table or two-column format, such as an \"Ingredients\" column next to a separate \"Size\", \"Wt\", or \"Amount\" column. When you see this, match each row across both columns and combine them into ONE ingredient entry - do not create separate, disconnected entries for the name and the size/weight, and do not put the size/weight text into \"unit\".\n" +
      "  Example: a row reading Ingredients: \"Boneless Sirloin Steaks\" and Size/Wt: \"6 to 8 oz each\" with a quantity of 4 shown should become {\"name\": \"boneless sirloin steaks, 6 to 8 oz each\", \"amount\": \"4\", \"unit\": \"\"}.\n" +
      "- \"unit\" should only ever contain a short unit word from the abbreviation list above (or be empty) - never a parenthetical, a weight range, or a package description. All of that belongs in \"name\" instead.\n" +
      "- If servings isn't shown, make a reasonable guess based on the dish and ingredient quantities.\n" +
      "\n" +
      "Rules for steps:\n" +
      "- Recipe instructions are very often written as one continuous paragraph or a single run-on sentence covering several actions. You must split these into separate steps yourself - do NOT return the original run-on text as one single step.\n" +
      "- Break the instructions into one step per distinct cooking action (season, heat, cook, flip, add an ingredient, rest, serve, etc.). A new step should start whenever the action, tool, or ingredient being worked with changes.\n" +
      "- Keep each step's wording close to the original text; you're splitting it apart, not rewriting or summarizing it.\n" +
      "- If you truly cannot read a word anywhere in the recipe, make your best guess rather than leaving it blank.";

    const body = {
      model: "claude-sonnet-5",
      max_tokens: 2000,
      messages: [
        {
          role: "user",
          content: [
            {
              type: "image",
              source: {
                type: "base64",
                media_type: mediaType,
                data: imageBase64,
              },
            },
            {type: "text", text: prompt},
          ],
        },
      ],
    };

    let resp;
    try {
      resp = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-api-key": anthropicApiKey.value(),
          "anthropic-version": "2023-06-01",
        },
        body: JSON.stringify(body),
      });
    } catch (err) {
      console.error("Network error calling Anthropic API", err);
      throw new HttpsError("unavailable", "Could not reach the vision service. Try again.");
    }

    if (!resp.ok) {
      const errText = await resp.text();
      console.error("Anthropic API error", resp.status, errText);
      throw new HttpsError("internal", "The vision service returned an error.");
    }

    const data = await resp.json();
    const textBlock = (data.content || []).find((b) => b.type === "text");
    const raw = textBlock ? textBlock.text : "";

    let parsed;
    try {
      const cleaned = raw.replace(/```json|```/g, "").trim();
      parsed = JSON.parse(cleaned);
    } catch (err) {
      console.error("Could not parse model response as JSON:", raw);
      throw new HttpsError("internal", "Could not understand the response. Try a clearer photo.");
    }

    return parsed;
  }
);
