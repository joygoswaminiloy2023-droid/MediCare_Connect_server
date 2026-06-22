const express = require("express");
const router = express.Router();
const { connectToDatabase } = require("../lib/db");
const { ObjectId } = require("mongodb");

// =========================================================================
// GET: ALL APPROVED DOCTORS with backend search & filter
// Query params: search, specialization, minRating, maxFee, sortBy, page, limit
//
// Example:
// GET /api/doctors?search=rahman&specialization=Cardiology&minRating=4.5&maxFee=500&sortBy=fee_asc&page=1&limit=9
// =========================================================================
router.get("/", async (req, res) => {
  try {
    const db = await connectToDatabase();

    const {
      search        = "",
      specialization = "",
      minRating      = 0,
      maxFee         = 100000,
      sortBy         = "default",
      page           = 1,
      limit          = 9
    } = req.query;

    // ── Build MongoDB filter query ────────────────────────────────────────
    const query = {};

    // 1. Text search — name, specialization, or hospital
    if (search.trim()) {
      query.$or = [
        { doctorName:     { $regex: search.trim(), $options: "i" } },
        { name:           { $regex: search.trim(), $options: "i" } },
        { specialization: { $regex: search.trim(), $options: "i" } },
        { hospitalName:   { $regex: search.trim(), $options: "i" } },
      ];
    }

    // 2. Specialization filter (exact-ish, case-insensitive)
    if (specialization && specialization !== "All Types") {
      query.specialization = { $regex: specialization.trim(), $options: "i" };
    }

    // 3. Min rating filter
    if (Number(minRating) > 0) {
      query.rating = { $gte: Number(minRating) };
    }

    // 4. Max fee filter
    if (Number(maxFee) < 100000) {
      query.consultationFee = { $lte: Number(maxFee) };
    }

    // ── Build sort ────────────────────────────────────────────────────────
    let sort = {};
    switch (sortBy) {
      case "fee_asc":  sort = { consultationFee: 1 };  break;
      case "fee_desc": sort = { consultationFee: -1 }; break;
      case "exp_desc": sort = { experience: -1 };      break;
      case "name_asc": sort = { doctorName: 1 };       break;
      default:         sort = { createdAt: -1 };        break; // newest first
    }

    // ── Pagination ────────────────────────────────────────────────────────
    const pageNum   = Math.max(1, Number(page));
    const limitNum  = Math.min(50, Math.max(1, Number(limit))); // cap at 50
    const skip      = (pageNum - 1) * limitNum;

    // ── Execute query + count in parallel ─────────────────────────────────
    const [doctors, total] = await Promise.all([
      db.collection("Doctor").find(query).sort(sort).skip(skip).limit(limitNum).toArray(),
      db.collection("Doctor").countDocuments(query)
    ]);

    res.status(200).json({
      success:    true,
      doctors,
      total,
      page:       pageNum,
      totalPages: Math.ceil(total / limitNum),
      limit:      limitNum
    });

  } catch (error) {
    console.error("Doctor search/filter failed:", error);
    res.status(500).json({ success: false, message: "Failed to load doctors." });
  }
});

// =========================================================================
// GET: DISTINCT SPECIALIZATIONS (for populating filter dropdown dynamically)
// GET /api/doctors/specializations
// =========================================================================
router.get("/specializations", async (req, res) => {
  try {
    const db = await connectToDatabase();
    const specs = await db.collection("Doctor").distinct("specialization");
    const cleaned = specs.filter(Boolean).sort();
    res.status(200).json({ success: true, specializations: cleaned });
  } catch (error) {
    res.status(500).json({ success: false, message: "Failed to load specializations." });
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
      degrees, qualifications,
      experience, consultationFee,
      availableSlots,
      image, profileImage
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

    // Block duplicate pending application
    const existingApplication = await db.collection("DoctorApplications").findOne({ email: normalizedEmail });
    if (existingApplication && existingApplication.verificationStatus === "pending") {
      return res.status(409).json({
        success: false,
        message: "You already have a pending application under review."
      });
    }
    // Rejected doctors can resubmit — falls through to upsert

    const processedSlots = Array.isArray(availableSlots)
      ? availableSlots
      : availableSlots ? [availableSlots] : ["9:00 AM", "11:00 AM", "4:00 PM"];

    const applicationPayload = {
      email:            normalizedEmail,
      doctorName:       doctorName || "New Specialist",
      specialization:   specialization || "General Medicine",
      hospitalName:     hospitalName || "General Practice Hospital",
      degrees:          degrees || qualifications || "MBBS",
      experience:       Number(experience) || 0,
      consultationFee:  Number(consultationFee) || 0,
      availableSlots:   processedSlots,
      image:            image || profileImage || "https://images.unsplash.com/photo-1559839734-2b71ea197ec2?w=150",
      verificationStatus: "pending",
      updatedAt:        new Date()
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