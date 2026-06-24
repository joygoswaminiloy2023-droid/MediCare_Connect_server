const express = require("express");
const router  = express.Router();
const { connectToDatabase } = require("../lib/db");
const { ObjectId } = require("mongodb");


// =========================================================================
// GET: ALL APPROVED DOCTORS with search & filter (rating/reviews are now
// computed live from the "Reviews" collection via $lookup, instead of
// reading a non-existent "rating" field stored on the Doctor document).
// =========================================================================
router.get("/", async (req, res) => {
  try {
    const db = await connectToDatabase();
    const {
      search = "", specialization = "", minRating = 0, maxFee = 100000,
      sortBy = "default", page = 1, limit = 9
    } = req.query;

    const match = {};
    if (search.trim()) {
      match.$or = [
        { doctorName:     { $regex: search.trim(), $options: "i" } },
        { name:           { $regex: search.trim(), $options: "i" } },
        { specialization: { $regex: search.trim(), $options: "i" } },
        { hospitalName:   { $regex: search.trim(), $options: "i" } },
      ];
    }
    if (specialization && specialization !== "All Types")
      match.specialization = { $regex: specialization.trim(), $options: "i" };
    if (Number(maxFee) < 100000) match.consultationFee = { $lte: Number(maxFee) };

    let sort = {};
    switch (sortBy) {
      case "fee_asc":     sort = { consultationFee: 1  }; break;
      case "fee_desc":    sort = { consultationFee: -1 }; break;
      case "exp_desc":    sort = { experience: -1 };      break;
      case "name_asc":    sort = { doctorName: 1 };       break;
      case "rating_desc": sort = { rating: -1 };          break;
      default:            sort = { createdAt: -1 };
    }

    const pageNum      = Math.max(1, Number(page));
    const limitNum     = Math.min(50, Math.max(1, Number(limit)));
    const skip         = (pageNum - 1) * limitNum;
    const minRatingNum = Number(minRating) || 0;

    const pipeline = [
      { $match: match },

      // Pull in this doctor's reviews from the "Reviews" collection
      {
        $lookup: {
          from: "Reviews",
          localField: "_id",
          foreignField: "doctorId",
          as: "reviewDocs"
        }
      },

      // Compute live rating average + review count.
      // Doctors with zero reviews default to a rating of 4 — this MUST match
      // the 4.00 placeholder shown on the frontend, otherwise unrated doctors
      // would visually show 4.00 but still get excluded by the minRating
      // match below (null never satisfies a $gte comparison).
      {
        $addFields: {
          reviews: { $size: "$reviewDocs" },
          rating: {
            $cond: [
              { $gt: [{ $size: "$reviewDocs" }, 0] },
              { $round: [{ $avg: "$reviewDocs.rating" }, 1] },
              4
            ]
          }
        }
      },

      // Drop the raw review documents, we only needed them for the calc above
      { $project: { reviewDocs: 0 } }
    ];

    // Only doctors meeting the minimum rating survive this filter.
    // Unrated doctors default to rating 4 above, so they correctly pass
    // "Any Rating" / "3.5 & above" / "4.0 & above", but not "4.5 & above".
    if (minRatingNum > 0) {
      pipeline.push({ $match: { rating: { $gte: minRatingNum } } });
    }

    pipeline.push(
      { $sort: sort },
      {
        $facet: {
          data: [{ $skip: skip }, { $limit: limitNum }],
          totalCount: [{ $count: "count" }]
        }
      }
    );

    const result   = await db.collection("Doctor").aggregate(pipeline).toArray();
    const doctors  = result[0]?.data || [];
    const total    = result[0]?.totalCount[0]?.count || 0;

    res.status(200).json({
      success: true,
      doctors,
      total,
      page: pageNum,
      totalPages: Math.ceil(total / limitNum),
      limit: limitNum
    });
  } catch (error) {
    console.error("Doctor list fetch failed:", error);
    res.status(500).json({ success: false, message: "Failed to load doctors." });
  }
});


// GET: DISTINCT SPECIALIZATIONS

router.get("/specializations", async (req, res) => {
  try {
    const db    = await connectToDatabase();
    const specs = await db.collection("Doctor").distinct("specialization");
    res.status(200).json({ success: true, specializations: specs.filter(Boolean).sort() });
  } catch (error) {
    res.status(500).json({ success: false, message: "Failed to load specializations." });
  }
});


// GET: DOCTOR DASHBOARD STATS (real data from DB)
// GET /api/doctors/dashboard-stats/:email

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


// GET: DOCTOR'S APPOINTMENTS by email

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


// PATCH: ACCEPT appointment

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


// PATCH: REJECT appointment

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


// POST: SAVE PRESCRIPTION

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


// GET: DOCTOR'S PRESCRIPTIONS

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


// POST: SUBMIT PRACTITIONER APPLICATION

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


// GET: CHECK PROFILE / APPLICATION STATUS by email

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


// =========================================================================
// POST: CREATE DOCTOR SCHEDULE
// =========================================================================
router.post("/schedule", async (req, res) => {
  try {
    const db = await connectToDatabase();
    const { doctorEmail, dayOfWeek, startTime, endTime } = req.body;

    if (!doctorEmail || !dayOfWeek || !startTime || !endTime) {
      return res.status(400).json({ success: false, message: "Missing required fields." });
    }

    const result = await db.collection("DoctorSchedule").insertOne({
      doctorEmail: doctorEmail.toLowerCase(),
      dayOfWeek,
      startTime,
      endTime,
      isActive: true,
      createdAt: new Date()
    });

    res.status(201).json({ success: true, scheduleId: result.insertedId });
  } catch (error) {
    console.error("Schedule creation failed:", error);
    res.status(500).json({ success: false, message: "Failed to create schedule." });
  }
});


// =========================================================================
// GET: DOCTOR'S SCHEDULES
// =========================================================================
router.get("/schedule/:doctorEmail", async (req, res) => {
  try {
    const db = await connectToDatabase();
    const schedules = await db.collection("DoctorSchedule")
      .find({ doctorEmail: req.params.doctorEmail.toLowerCase() })
      .sort({ createdAt: -1 })
      .toArray();

    res.status(200).json({ success: true, schedules });
  } catch (error) {
    console.error("Failed to fetch schedules:", error);
    res.status(500).json({ success: false, message: "Failed to fetch schedules." });
  }
});


// =========================================================================
// PATCH: UPDATE SCHEDULE
// =========================================================================
router.patch("/schedule/:scheduleId", async (req, res) => {
  try {
    const db = await connectToDatabase();
    const { dayOfWeek, startTime, endTime, isActive } = req.body;

    const updateData = {};
    if (dayOfWeek !== undefined) updateData.dayOfWeek = dayOfWeek;
    if (startTime !== undefined) updateData.startTime = startTime;
    if (endTime !== undefined) updateData.endTime = endTime;
    if (isActive !== undefined) updateData.isActive = isActive;
    updateData.updatedAt = new Date();

    const result = await db.collection("DoctorSchedule").updateOne(
      { _id: new ObjectId(req.params.scheduleId) },
      { $set: updateData }
    );

    if (result.matchedCount === 0) {
      return res.status(404).json({ success: false, message: "Schedule not found." });
    }

    res.status(200).json({ success: true, message: "Schedule updated." });
  } catch (error) {
    console.error("Update failed:", error);
    res.status(500).json({ success: false, message: "Failed to update schedule." });
  }
});


// =========================================================================
// DELETE: SCHEDULE
// =========================================================================
router.delete("/schedule/:scheduleId", async (req, res) => {
  try {
    const db = await connectToDatabase();

    const result = await db.collection("DoctorSchedule").deleteOne({
      _id: new ObjectId(req.params.scheduleId)
    });

    if (result.deletedCount === 0) {
      return res.status(404).json({ success: false, message: "Schedule not found." });
    }

    res.status(200).json({ success: true, message: "Schedule deleted." });
  } catch (error) {
    console.error("Delete failed:", error);
    res.status(500).json({ success: false, message: "Failed to delete schedule." });
  }
});


// =========================================================================
// GET: FEATURED REVIEWS ACROSS ALL DOCTORS (for homepage testimonials)
// IMPORTANT: this route is registered BEFORE "/reviews/:doctorId" below —
// if it came after, Express would match "/reviews/featured" against the
// dynamic route instead and try (and fail) to cast "featured" to an ObjectId.
// =========================================================================
router.get("/reviews/featured", async (req, res) => {
  try {
    const db = await connectToDatabase();
    const limitNum     = Math.min(20, Math.max(1, Number(req.query.limit) || 6));
    const minRatingNum = Number(req.query.minRating) || 4; // only surface solid reviews by default

    const reviews = await db.collection("Reviews").aggregate([
      {
        $match: {
          rating: { $gte: minRatingNum },
          reviewText: { $exists: true, $ne: "" }
        }
      },
      { $sort: { rating: -1, createdAt: -1 } },
      { $limit: limitNum },

      // Pull in the doctor this review was about
      {
        $lookup: {
          from: "Doctor",
          localField: "doctorId",
          foreignField: "_id",
          as: "doctorInfo"
        }
      },

      // Reviews only stores patientEmail, not a display name. The
      // appointment captured at booking time is the most likely place
      // a real patient name would have been recorded, so try that first.
      {
        $lookup: {
          from: "Appointments",
          localField: "appointmentId",
          foreignField: "_id",
          as: "appointmentInfo"
        }
      },

      {
        $addFields: {
          doctorInfo:      { $arrayElemAt: ["$doctorInfo", 0] },
          appointmentInfo: { $arrayElemAt: ["$appointmentInfo", 0] }
        }
      },

      {
        $project: {
          _id: 1,
          rating: 1,
          reviewText: 1,
          createdAt: 1,
          patientEmail: 1,
          // null if the Appointments schema doesn't actually have these
          // fields — the frontend falls back to deriving a name from the email
          patientName: {
            $ifNull: ["$appointmentInfo.patientName", "$appointmentInfo.name"]
          },
          doctorName:     "$doctorInfo.doctorName",
          specialization: "$doctorInfo.specialization"
        }
      }
    ]).toArray();

    res.status(200).json({ success: true, reviews });
  } catch (error) {
    console.error("Failed to fetch featured reviews:", error);
    res.status(500).json({ success: false, message: "Failed to fetch featured reviews." });
  }
});


// =========================================================================
// GET: DOCTOR'S REVIEWS (for cards display / doctor profile page)
// =========================================================================
router.get("/reviews/:doctorId", async (req, res) => {
  try {
    const db = await connectToDatabase();
    const doctorId = new ObjectId(req.params.doctorId);

    const reviews = await db.collection("Reviews")
      .find({ doctorId })
      .sort({ createdAt: -1 })
      .toArray();

    // Calculate average rating
    const avgRating = reviews.length > 0
      ? (reviews.reduce((sum, r) => sum + (Number(r.rating) || 0), 0) / reviews.length).toFixed(1)
      : 0;

    res.status(200).json({
      success: true,
      reviews,
      averageRating: parseFloat(avgRating),
      reviewCount: reviews.length
    });
  } catch (error) {
    console.error("Failed to fetch reviews:", error);
    res.status(500).json({ success: false, message: "Failed to fetch reviews." });
  }
});

module.exports = router;