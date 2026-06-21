const express = require("express");
const router = express.Router();
const { connectToDatabase } = require("../lib/db");
const { ObjectId } = require("mongodb");

// =========================================================================
// GET: ALL APPROVED/LIVE DOCTORS for public UI
// Fetches from "Doctor" collection — everything here is approved.
// Does NOT filter by verificationStatus (old doctors may not have that field).
// =========================================================================
router.get("/", async (req, res) => {
  try {
    const db = await connectToDatabase();
    // Doctor collection = approved only. No status filter needed.
    const doctors = await db.collection("Doctor").find({}).toArray();
    res.status(200).json({ success: true, doctors });
  } catch (error) {
    res.status(500).json({ success: false, message: "Failed to load doctors." });
  }
});

// =========================================================================
// POST: SUBMIT PRACTITIONER APPLICATION (staging only — never touches Doctor)
// =========================================================================
router.post("/profile", async (req, res) => {
  try {
    const db = await connectToDatabase();

    const {
      email, doctorName, specialization, hospitalName,
      degrees, qualifications,          // frontend sends "qualifications", backend stores as "degrees"
      experience, consultationFee,
      availableSlots,
      image, profileImage               // frontend sends "profileImage", backend stores as "image"
    } = req.body;

    if (!email) {
      return res.status(400).json({ success: false, message: "Email is required." });
    }

    const normalizedEmail = email.trim().toLowerCase();

    // Block if already an approved live doctor
    const existingApproved = await db.collection("Doctor").findOne({ email: normalizedEmail });
    if (existingApproved) {
      return res.status(409).json({
        success: false,
        message: "This account is already an approved practitioner. Contact admin to update your profile."
      });
    }

    // Check for existing application
    const existingApplication = await db.collection("DoctorApplications").findOne({ email: normalizedEmail });

    if (existingApplication && existingApplication.verificationStatus === "pending") {
      return res.status(409).json({
        success: false,
        message: "You already have a pending application under review."
      });
    }
    // If rejected — allow resubmission (falls through to upsert below)

    const processedSlots = Array.isArray(availableSlots)
      ? availableSlots
      : availableSlots ? [availableSlots] : ["9:00 AM", "11:00 AM", "4:00 PM"];

    const applicationPayload = {
      email: normalizedEmail,
      doctorName: doctorName || "New Specialist",
      specialization: specialization || "General Medicine",
      hospitalName: hospitalName || "General Practice Hospital",
      degrees: degrees || qualifications || "MBBS", // ✅ accepts both field names from frontend
      experience: Number(experience) || 0,
      consultationFee: Number(consultationFee) || 0,
      availableSlots: processedSlots,
      image: image || profileImage || "https://images.unsplash.com/photo-1559839734-2b71ea197ec2?w=150",
      verificationStatus: "pending",
      updatedAt: new Date()
    };

    const result = await db.collection("DoctorApplications").updateOne(
      { email: normalizedEmail },
      { $set: applicationPayload, $setOnInsert: { createdAt: new Date() } },
      { upsert: true }
    );

    res.status(200).json({
      success: true,
      message: "Profile submitted for admin review. It will go live once approved.",
      result
    });

  } catch (error) {
    console.error("Doctor application submission failed:", error);
    res.status(500).json({ success: false, message: "Submission failed.", error: error.message });
  }
});

// =========================================================================
// GET: CHECK PROFILE / APPLICATION STATUS by email
// =========================================================================
router.get("/profile/:email", async (req, res) => {
  try {
    const db = await connectToDatabase();
    const targetEmail = req.params.email.trim().toLowerCase();

    const approvedProfile = await db.collection("Doctor").findOne({ email: targetEmail });
    if (approvedProfile) {
      return res.status(200).json({ success: true, profile: approvedProfile, status: "approved" });
    }

    const application = await db.collection("DoctorApplications").findOne({ email: targetEmail });
    if (application) {
      return res.status(200).json({
        success: true,
        profile: application,
        status: application.verificationStatus || "pending"
      });
    }

    return res.status(404).json({ success: false, message: "No profile registered yet." });

  } catch (error) {
    res.status(500).json({ success: false, message: "Error looking up doctor profile." });
  }
});

module.exports = router;