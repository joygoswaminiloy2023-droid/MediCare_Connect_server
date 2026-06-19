const express = require("express");
const router = express.Router();
const { connectToDatabase } = require("../lib/db");

router.get("/profile", async (req, res) => {
  try {
    const { email } = req.query;
    const { db } = await connectToDatabase();
    const collection = db.collection("Doctor");

    // Scenario A: If an email parameter query exists, fetch that specific doctor profile
    if (email) {
      const doctor = await collection.findOne({ email: email.trim().toLowerCase() });
      if (!doctor) {
        return res.status(404).json({ message: "No practitioner profile found linked to this email." });
      }
      return res.status(200).json(doctor);
    }

    // Scenario B: NO email provided -> Find and return EVERY doctor record for the homepage!
    const allDoctors = await collection.find({}).sort({ _id: -1 }).toArray();
    return res.status(200).json(allDoctors);

  } catch (error) {
    console.error("Error inside GET /profile endpoint:", error);
    return res.status(500).json({ success: false, message: "Internal server pipeline extraction error." });
  }
});


router.post("/profile", async (req, res) => {
  try {
    const data = req.body;
    const { db } = await connectToDatabase();
    const collection = db.collection("Doctor");

    if (!data.email) {
      return res.status(400).json({ success: false, message: "Validation error: Missing tracking email identity." });
    }

    const targetEmail = data.email.trim().toLowerCase();

    const parseToArray = (input) => {
      if (Array.isArray(input)) return input;
      if (typeof input === "string") return input.split(",").map(str => str.trim()).filter(Boolean);
      return [];
    };

    const formattedPayload = {
      doctorName: data.doctorName,
      email: targetEmail,
      specialization: data.specialization,
      hospitalName: data.hospitalName,
      qualifications: parseToArray(data.qualifications),
      experience: Number(data.experience) || 0,
      consultationFee: Number(data.consultationFee) || 0,
      availableSlots: parseToArray(data.availableSlots),
      profileImage: data.profileImage || "https://images.unsplash.com/photo-1622253692010-333f2da6031d?auto=format&fit=crop&w=256&h=256&q=80",
      updatedAt: new Date()
    };

    await collection.updateOne(
      { email: targetEmail },
      { 
        $set: formattedPayload,
        $setOnInsert: { createdAt: new Date() }
      },
      { upsert: true }
    );

    return res.status(200).json({
      success: true,
      message: "Practitioner details successfully aligned via Native Driver.",
      data: formattedPayload
    });

  } catch (error) {
    console.error("Error inside POST /profile endpoint:", error);
    return res.status(500).json({ success: false, message: "Database tracking write operation failure." });
  }
});

module.exports = router;