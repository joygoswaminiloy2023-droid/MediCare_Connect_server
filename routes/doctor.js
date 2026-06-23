const express = require("express");
const router  = express.Router();
const { connectToDatabase } = require("../lib/db");
const { ObjectId } = require("mongodb");

// =========================================================================
// GET: ALL APPROVED DOCTORS with search & filter
// =========================================================================
router.get("/", async (req, res) => {
  try {
    const db = await connectToDatabase();
    const { search = "", specialization = "", minRating = 0, maxFee = 100000, sortBy = "default", page = 1, limit = 9 } = req.query;
    const query = {};
    if (search.trim()) {
      query.$or = [
        { doctorName:     { $regex: search.trim(), $options: "i" } },
        { name:           { $regex: search.trim(), $options: "i" } },
        { specialization: { $regex: search.trim(), $options: "i" } },
        { hospitalName:   { $regex: search.trim(), $options: "i" } },
      ];
    }
    if (specialization && specialization !== "All Types")
      query.specialization = { $regex: specialization.trim(), $options: "i" };
    if (Number(minRating) > 0) query.rating = { $gte: Number(minRating) };
    if (Number(maxFee) < 100000) query.consultationFee = { $lte: Number(maxFee) };

    let sort = {};
    switch (sortBy) {
      case "fee_asc":  sort = { consultationFee: 1  }; break;
      case "fee_desc": sort = { consultationFee: -1 }; break;
      case "exp_desc": sort = { experience: -1 };      break;
      case "name_asc": sort = { doctorName: 1 };       break;
      default:         sort = { createdAt: -1 };
    }
    const pageNum  = Math.max(1, Number(page));
    const limitNum = Math.min(50, Math.max(1, Number(limit)));
    const skip     = (pageNum - 1) * limitNum;
    const [doctors, total] = await Promise.all([
      db.collection("Doctor").find(query).sort(sort).skip(skip).limit(limitNum).toArray(),
      db.collection("Doctor").countDocuments(query)
    ]);
    res.status(200).json({ success: true, doctors, total, page: pageNum, totalPages: Math.ceil(total / limitNum), limit: limitNum });
  } catch (error) {
    res.status(500).json({ success: false, message: "Failed to load doctors." });
  }
});

// =========================================================================
// GET: DISTINCT SPECIALIZATIONS
// =========================================================================
router.get("/specializations", async (req, res) => {
  try {
    const db    = await connectToDatabase();
    const specs = await db.collection("Doctor").distinct("specialization");
    res.status(200).json({ success: true, specializations: specs.filter(Boolean).sort() });
  } catch (error) {
    res.status(500).json({ success: false, message: "Failed to load specializations." });
  }
});

// =========================================================================
// GET: DOCTOR DASHBOARD STATS (real data from DB)
// GET /api/doctors/dashboard-stats/:email
// =========================================================================
router.get("/dashboard-stats/:email", async (req, res) => {
  try {
    const db          = await connectToDatabase();
    const doctorEmail = req.params.email.trim().toLowerCase();

    // Find doctor
    const doctor = await db.collection("Doctor").findOne({ email: doctorEmail });
    if (!doctor) return res.status(404).json({ success: false, message: "Doctor not found." });

    const doctorOid = doctor._id;
    const today     = new Date().toISOString().split("T")[0];

    // Run all counts in parallel
    const [
      totalAppointments,
      pendingAppointments,
      confirmedAppointments,
      completedAppointments,
      todayAppointments,
      totalPatients,
      totalReviews,
      recentAppointments,
      avgRatingResult
    ] = await Promise.all([
      // Total appointments for this doctor
      db.collection("Appointments").countDocuments({ doctorId: doctorOid }),

      // Pending
      db.collection("Appointments").countDocuments({ doctorId: doctorOid, appointmentStatus: "pending" }),

      // Confirmed
      db.collection("Appointments").countDocuments({ doctorId: doctorOid, appointmentStatus: "confirmed" }),

      // Completed
      db.collection("Appointments").countDocuments({ doctorId: doctorOid, appointmentStatus: "completed" }),

      // Today's appointments
      db.collection("Appointments").countDocuments({ doctorId: doctorOid, appointmentDate: today }),

      // Unique patients (distinct patientId)
      db.collection("Appointments").distinct("patientId", { doctorId: doctorOid }),

      // Total reviews
      db.collection("Reviews").countDocuments({ doctorId: doctorOid }),

      // Recent 5 appointments
      db.collection("Appointments")
        .find({ doctorId: doctorOid })
        .sort({ createdAt: -1 })
        .limit(5)
        .toArray(),

      // Average rating
      db.collection("Reviews").aggregate([
        { $match: { doctorId: doctorOid } },
        { $group: { _id: null, avg: { $avg: { $toDouble: "$rating" } } } }
      ]).toArray()
    ]);

    res.status(200).json({
      success: true,
      stats: {
        totalAppointments,
        pendingAppointments,
        confirmedAppointments,
        completedAppointments,
        todayAppointments,
        totalPatients:  totalPatients.filter(Boolean).length,
        totalReviews,
        avgRating:      avgRatingResult[0]?.avg ? Number(avgRatingResult[0].avg.toFixed(1)) : 0,
      },
      recentAppointments
    });
  } catch (error) {
    console.error("Dashboard stats failed:", error);
    res.status(500).json({ success: false, message: "Failed to load dashboard stats." });
  }
});

// =========================================================================
// GET: DOCTOR'S APPOINTMENTS by email
// =========================================================================
router.get("/appointments/:email", async (req, res) => {
  try {
    const db     = await connectToDatabase();
    const doctor = await db.collection("Doctor").findOne({ email: req.params.email.trim().toLowerCase() });
    if (!doctor) return res.status(404).json({ success: false, message: "Doctor not found." });

    const appointments = await db.collection("Appointments")
      .find({ doctorId: doctor._id })
      .sort({ createdAt: -1 })
      .toArray();

    res.status(200).json({ success: true, appointments });
  } catch (error) {
    res.status(500).json({ success: false, message: "Failed to fetch appointments." });
  }
});

// =========================================================================
// PATCH: ACCEPT appointment
// =========================================================================
router.patch("/appointments/:id/accept", async (req, res) => {
  try {
    const db = await connectToDatabase();
    await db.collection("Appointments").updateOne(
      { _id: new ObjectId(req.params.id) },
      { $set: { appointmentStatus: "confirmed", updatedAt: new Date() } }
    );
    res.status(200).json({ success: true, message: "Appointment confirmed." });
  } catch (error) {
    res.status(500).json({ success: false, message: "Failed to accept." });
  }
});

// =========================================================================
// PATCH: REJECT appointment
// =========================================================================
router.patch("/appointments/:id/reject", async (req, res) => {
  try {
    const db = await connectToDatabase();
    await db.collection("Appointments").updateOne(
      { _id: new ObjectId(req.params.id) },
      { $set: { appointmentStatus: "rejected", updatedAt: new Date() } }
    );
    res.status(200).json({ success: true, message: "Appointment rejected." });
  } catch (error) {
    res.status(500).json({ success: false, message: "Failed to reject." });
  }
});

// =========================================================================
// POST: SAVE PRESCRIPTION → also marks appointment as "completed"
// Saves to Prescriptions collection (your schema)
// =========================================================================
router.post("/prescriptions", async (req, res) => {
  try {
    const db = await connectToDatabase();
    const { doctorId, patientId, appointmentId, diagnosis, medications, notes } = req.body;

    if (!doctorId || !appointmentId || !diagnosis)
      return res.status(400).json({ success: false, message: "doctorId, appointmentId and diagnosis are required." });

    // Save to Prescriptions (exact schema match)
    const result = await db.collection("Prescriptions").insertOne({
      doctorId:      new ObjectId(doctorId),
      patientId:     patientId ? new ObjectId(patientId) : null,
      appointmentId: new ObjectId(appointmentId),
      diagnosis,
      medications:   medications || "",
      notes:         notes       || "",
      createdAt:     new Date()
    });

    // Mark appointment completed
    await db.collection("Appointments").updateOne(
      { _id: new ObjectId(appointmentId) },
      { $set: { appointmentStatus: "completed", updatedAt: new Date() } }
    );

    res.status(201).json({ success: true, prescriptionId: result.insertedId });
  } catch (error) {
    console.error("Prescription save failed:", error);
    res.status(500).json({ success: false, message: "Failed to save prescription.", error: error.message });
  }
});

// =========================================================================
// GET: DOCTOR'S PRESCRIPTIONS
// =========================================================================
router.get("/prescriptions/:doctorId", async (req, res) => {
  try {
    const db = await connectToDatabase();
    const prescriptions = await db.collection("Prescriptions")
      .find({ doctorId: new ObjectId(req.params.doctorId) })
      .sort({ createdAt: -1 })
      .toArray();
    res.status(200).json({ success: true, prescriptions });
  } catch (error) {
    res.status(500).json({ success: false, message: "Failed to fetch prescriptions." });
  }
});

// =========================================================================
// POST: SUBMIT PRACTITIONER APPLICATION
// =========================================================================
router.post("/profile", async (req, res) => {
  try {
    const db = await connectToDatabase();
    const { email, doctorName, specialization, hospitalName, degrees, qualifications, experience, consultationFee, availableSlots, image, profileImage } = req.body;
    if (!email) return res.status(400).json({ success: false, message: "Email is required." });

    const normalizedEmail = email.trim().toLowerCase();
    const existingApproved = await db.collection("Doctor").findOne({ email: normalizedEmail });
    if (existingApproved) return res.status(409).json({ success: false, message: "Already an approved practitioner." });

    const existingApp = await db.collection("DoctorApplications").findOne({ email: normalizedEmail });
    if (existingApp && existingApp.verificationStatus === "pending")
      return res.status(409).json({ success: false, message: "Pending application already under review." });

    const processedSlots = Array.isArray(availableSlots) ? availableSlots : availableSlots ? [availableSlots] : ["9:00 AM", "11:00 AM", "4:00 PM"];

    const result = await db.collection("DoctorApplications").updateOne(
      { email: normalizedEmail },
      {
        $set: {
          email: normalizedEmail,
          doctorName:       doctorName    || "New Specialist",
          specialization:   specialization || "General Medicine",
          hospitalName:     hospitalName   || "General Practice Hospital",
          degrees:          degrees || qualifications || "MBBS",
          experience:       Number(experience)      || 0,
          consultationFee:  Number(consultationFee) || 0,
          availableSlots:   processedSlots,
          image:            image || profileImage || "https://images.unsplash.com/photo-1559839734-2b71ea197ec2?w=150",
          verificationStatus: "pending",
          updatedAt:        new Date()
        },
        $setOnInsert: { createdAt: new Date() }
      },
      { upsert: true }
    );

    res.status(200).json({ success: true, message: "Profile submitted for admin review.", result });
  } catch (error) {
    res.status(500).json({ success: false, message: "Submission failed.", error: error.message });
  }
});

// =========================================================================
// GET: CHECK PROFILE / APPLICATION STATUS by email
// =========================================================================
router.get("/profile/:email", async (req, res) => {
  try {
    const db          = await connectToDatabase();
    const targetEmail = req.params.email.trim().toLowerCase();
    const approved    = await db.collection("Doctor").findOne({ email: targetEmail });
    if (approved) return res.status(200).json({ success: true, profile: approved, status: "approved" });
    const application = await db.collection("DoctorApplications").findOne({ email: targetEmail });
    if (application) return res.status(200).json({ success: true, profile: application, status: application.verificationStatus || "pending" });
    return res.status(404).json({ success: false, message: "No profile registered yet." });
  } catch (error) {
    res.status(500).json({ success: false, message: "Error looking up doctor profile." });
  }
});

module.exports = router;