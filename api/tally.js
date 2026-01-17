const { createClient } = require("@supabase/supabase-js");

function isUuid(v) {
  return typeof v === "string" &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(v);
}

function extractWeddingId(body) {
  return (
    body?.wedding_id ||
    body?.hidden?.wedding_id ||
    body?.data?.wedding_id ||
    body?.fields?.wedding_id ||
    null
  );
}

function extractProviderSubmissionId(body) {
  return (
    body?.submission_id ||
    body?.submissionId ||
    body?.event_id ||
    body?.eventId ||
    body?.id ||
    null
  );
}

module.exports = async (req, res) => {
  try {
    if (req.method !== "POST") return res.status(200).send("OK");

    const body = req.body || {};
    const weddingId = extractWeddingId(body);

    if (!isUuid(weddingId)) {
      return res.status(400).json({
        ok: false,
        error: "Missing/invalid wedding_id UUID in webhook payload.",
        received_wedding_id: weddingId ?? null,
        body_keys: Object.keys(body || {}),
        // show a small preview so we can see where Tally put things (safe + short)
        body_preview: JSON.stringify(body || {}).slice(0, 800),
      });
    }
    const supabase = createClient(
      process.env.SUPABASE_URL,
      process.env.SUPABASE_SERVICE_ROLE_KEY
    );

    const providerSubmissionId = extractProviderSubmissionId(body);

    const { error } = await supabase.from("submissions_raw").insert({
      wedding_id: weddingId,
      provider: "tally",
      provider_submission_id: providerSubmissionId,
      payload: body,
    });

    if (error) {
      // If webhook retries, duplicates can happen. Treat unique/duplicate as success.
      const msg = String(error.message || "").toLowerCase();
      const isUnique = msg.includes("duplicate") || msg.includes("unique");
      if (!isUnique) {
        console.error("Supabase insert error:", error);
        return res.status(500).json({ ok: false, error: error.message });
      }
    }

    return res.status(200).json({ ok: true });
  } catch (err) {
    console.error("Receiver crash:", err);
    return res.status(500).json({ ok: false, error: "Server error" });
  }
};
