module.exports = async (req, res) => {
  try {
    if (req.method !== "POST") {
      return res.status(200).send("OK");
    }

    console.log("TALLY WEBHOOK PAYLOAD:", JSON.stringify(req.body, null, 2));
    return res.status(200).json({ ok: true });
  } catch (err) {
    console.error("Function error:", err);
    return res.status(500).json({ ok: false, error: "Server error" });
  }
};
