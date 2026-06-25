const express = require("express");
const router  = express.Router();
const { connectToDatabase } = require("../lib/db");
const { ObjectId } = require("mongodb");

// =========================================================================
// GET: ALL APPROVED DOCTORS with search & filter + REAL RATINGS
// =========================================================================
router.get("/", async (req, res) => {
  try {
    const db = await connectToDatabase();
    const { 
      search = "", 
      specialization = "", 
      minRating = 0, 
      maxFee = 100000, 
      sortBy = "default", 
      page = 1, 
      limit = 9 
    } = req.query;

    // ✅ Build match query for doctors (excluding rating since it's calculated)
    const matchQuery = {};
    
    if (search.trim()) {
      matchQuery.$or = [
        { doctorName:     { $regex: search.trim(), $options: "i" } },
        { name:           { $regex: search.trim(), $options: "i" } },
        { specialization: { $regex: search.trim(), $options: "i" } },
        { hospitalName:   { $regex: search.trim(), $options: "i" } },
      ];
    }
    if (specialization && specialization !== "All Types" && specialization !== "All") {
      matchQuery.specialization = { $regex: specialization.trim(), $options: "i" };
    }
    if (Number(maxFee) < 100000) {
      matchQuery.consultationFee = { $lte: Number(maxFee) };
    }

    // ✅ Build sort
    let sort = {};
    switch (sortBy) {
      case "fee_asc":   sort = { consultationFee: 1  }; break;
      case "fee_desc":  sort = { consultationFee: -1 }; break;
      case "exp_desc":  sort = { experience: -1 };      break;
      case "name_asc":  sort = { doctorName: 1 };       break;
      case "rating_desc": sort = { avgRating: -1 };    break;
      default:          sort = { createdAt: -1 };
    }

    const pageNum  = Math.max(1, Number(page));
    const limitNum = Math.min(50, Math.max(1, Number(limit)));
    const skip     = (pageNum - 1) * limitNum;

    // ✅ Get doctors with real ratings from Reviews collection
    const pipeline = [
      // Stage 1: Match doctors based on search/fee/specialization
      { $match: matchQuery },
      
      // Stage 2: Lookup reviews
      {
        $lookup: {
          from: "Reviews",
          localField: "_id",
          foreignField: "doctorId",
          as: "reviewData"
        }
      },
      
      // Stage 3: Calculate average rating and review count
      {
        $addFields: {
          reviewCount: { $size: "$reviewData" },
          avgRating: {
            $cond: [
              { $gt: [{ $size: "$reviewData" }, 0] },
              { $round: [{ $avg: "$reviewData.rating" }, 1] },
              0
            ]
          },
          patientCount: {
            $size: {
              $reduce: {
                input: "$reviewData",
                initialValue: [],
                in: {
                  $cond: [
                    { $in: ["$$this.patientEmail", "$$value"] },
                    "$$value",
                    { $concatArrays: ["$$value", ["$$this.patientEmail"]] }
                  ]
                }
              }
            }
          }
        }
      },
      
      // Stage 4: Filter by minRating (after calculation)
      ...(Number(minRating) > 0 ? [{
        $match: {
          avgRating: { $gte: Number(minRating) }
        }
      }] : []),
      
      // Stage 5: Remove reviewData from output
      {
        $project: {
          reviewData: 0
        }
      },
      
      // Stage 6: Sort
      { $sort: sort },
      
      // Stage 7: Pagination
      { $skip: skip },
      { $limit: limitNum }
    ];

    // ✅ Get total count with same filters (for pagination)
    const countPipeline = [
      { $match: matchQuery },
      {
        $lookup: {
          from: "Reviews",
          localField: "_id",
          foreignField: "doctorId",
          as: "reviewData"
        }
      },
      {
        $addFields: {
          avgRating: {
            $cond: [
              { $gt: [{ $size: "$reviewData" }, 0] },
              { $round: [{ $avg: "$reviewData.rating" }, 1] },
              0
            ]
          }
        }
      },
      ...(Number(minRating) > 0 ? [{
        $match: {
          avgRating: { $gte: Number(minRating) }
        }
      }] : []),
      { $count: "total" }
    ];

    const [doctors, totalResult] = await Promise.all([
      db.collection("Doctor").aggregate(pipeline).toArray(),
      db.collection("Doctor").aggregate(countPipeline).toArray()
    ]);

    const total = totalResult[0]?.total || 0;

    res.status(200).json({ 
      success: true, 
      doctors, 
      total, 
      page: pageNum, 
      totalPages: Math.ceil(total / limitNum), 
      limit: limitNum 
    });
  } catch (error) {
    console.error("Doctor list error:", error);
    res.status(500).json({ success: false, message: "Failed to load doctors." });
  }
});

// =========================================================================
// GET: TOP RATED DOCTORS for Homepage
// =========================================================================
router.get("/top-rated", async (req, res) => {
  try {
    const db = await connectToDatabase();
    const limitNum = Math.min(10, Math.max(1, Number(req.query.limit) || 6));

    const doctors = await db.collection("Doctor").aggregate([
      { $match: { verificationStatus: "verified" } },
      {
        $lookup: {
          from: "Reviews",
          localField: "_id",
          foreignField: "doctorId",
          as: "reviewData"
        }
      },
      {
        $addFields: {
          reviewCount: { $size: "$reviewData" },
          avgRating: {
            $cond: [
              { $gt: [{ $size: "$reviewData" }, 0] },
              { $round: [{ $avg: "$reviewData.rating" }, 1] },
              0
            ]
          },
          patientCount: {
            $size: {
              $reduce: {
                input: "$reviewData",
                initialValue: [],
                in: {
                  $cond: [
                    { $in: ["$$this.patientEmail", "$$value"] },
                    "$$value",
                    { $concatArrays: ["$$value", ["$$this.patientEmail"]] }
                  ]
                }
              }
            }
          }
        }
      },
      {
        $project: {
          reviewData: 0
        }
      },
      { $sort: { avgRating: -1, reviewCount: -1 } },
      { $limit: limitNum }
    ]).toArray();

    res.status(200).json({ 
      success: true, 
      doctors: doctors || [],
      count: doctors?.length || 0
    });
  } catch (error) {
    console.error("Top rated doctors error:", error);
    res.status(200).json({ 
      success: true, 
      doctors: [],
      count: 0,
      message: "No top rated doctors available yet"
    });
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
// =========================================================================
router.get("/dashboard-stats/:email", async (req, res) => {
  try {
    const db          = await connectToDatabase();
    const doctorEmail = req.params.email.trim().toLowerCase();

    const doctor = await db.collection("Doctor").findOne({ email: doctorEmail });
    if (!doctor) return res.status(404).json({ success: false, message: "Doctor not found." });

    const doctorOid = doctor._id;
    const today     = new Date().toISOString().split("T")[0];

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
      db.collection("Appointments").countDocuments({ doctorId: doctorOid }),
      db.collection("Appointments").countDocuments({ doctorId: doctorOid, appointmentStatus: "pending" }),
      db.collection("Appointments").countDocuments({ doctorId: doctorOid, appointmentStatus: "confirmed" }),
      db.collection("Appointments").countDocuments({ doctorId: doctorOid, appointmentStatus: "completed" }),
      db.collection("Appointments").countDocuments({ doctorId: doctorOid, appointmentDate: today }),
      db.collection("Appointments").distinct("patientId", { doctorId: doctorOid }),
      db.collection("Reviews").countDocuments({ doctorId: doctorOid }),
      db.collection("Appointments")
        .find({ doctorId: doctorOid })
        .sort({ createdAt: -1 })
        .limit(5)
        .toArray(),
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
// FIXED: ACCEPT appointment - ONLY updates, does NOT create new
// =========================================================================
router.patch("/appointments/:id/accept", async (req, res) => {
  try {
    const db = await connectToDatabase();
    const appointmentId = req.params.id;

    const existingAppointment = await db.collection("Appointments").findOne({
      _id: new ObjectId(appointmentId)
    });

    if (!existingAppointment) {
      return res.status(404).json({ 
        success: false, 
        message: "Appointment not found." 
      });
    }

    if (existingAppointment.appointmentStatus !== "pending") {
      return res.status(400).json({ 
        success: false, 
        message: `Cannot accept appointment with status: ${existingAppointment.appointmentStatus}` 
      });
    }

    await db.collection("Appointments").updateOne(
      { _id: new ObjectId(appointmentId) },
      { 
        $set: { 
          appointmentStatus: "confirmed", 
          confirmedAt: new Date(),
          updatedAt: new Date() 
        } 
      }
    );

    const updatedAppointment = await db.collection("Appointments").findOne({
      _id: new ObjectId(appointmentId)
    });

    res.status(200).json({ 
      success: true, 
      message: "Appointment confirmed.",
      appointment: updatedAppointment
    });
  } catch (error) {
    console.error("Accept error:", error);
    res.status(500).json({ success: false, message: "Failed to accept." });
  }
});

// =========================================================================
// FIXED: REJECT appointment - ONLY updates, does NOT create new
// =========================================================================
router.patch("/appointments/:id/reject", async (req, res) => {
  try {
    const db = await connectToDatabase();
    const appointmentId = req.params.id;

    const existingAppointment = await db.collection("Appointments").findOne({
      _id: new ObjectId(appointmentId)
    });

    if (!existingAppointment) {
      return res.status(404).json({ 
        success: false, 
        message: "Appointment not found." 
      });
    }

    if (existingAppointment.appointmentStatus !== "pending") {
      return res.status(400).json({ 
        success: false, 
        message: `Cannot reject appointment with status: ${existingAppointment.appointmentStatus}` 
      });
    }

    await db.collection("Appointments").updateOne(
      { _id: new ObjectId(appointmentId) },
      { 
        $set: { 
          appointmentStatus: "rejected", 
          rejectedAt: new Date(),
          updatedAt: new Date() 
        } 
      }
    );

    res.status(200).json({ 
      success: true, 
      message: "Appointment rejected." 
    });
  } catch (error) {
    console.error("Reject error:", error);
    res.status(500).json({ success: false, message: "Failed to reject." });
  }
});

// =========================================================================
// POST: SAVE PRESCRIPTION → also marks appointment as "completed"
// =========================================================================
router.post("/prescriptions", async (req, res) => {
  try {
    const db = await connectToDatabase();
    const { doctorId, patientId, appointmentId, diagnosis, medications, notes } = req.body;

    if (!doctorId || !appointmentId || !diagnosis)
      return res.status(400).json({ success: false, message: "doctorId, appointmentId and diagnosis are required." });

    const result = await db.collection("Prescriptions").insertOne({
      doctorId:      new ObjectId(doctorId),
      patientId:     patientId ? new ObjectId(patientId) : null,
      appointmentId: new ObjectId(appointmentId),
      diagnosis,
      medications:   medications || "",
      notes:         notes       || "",
      createdAt:     new Date()
    });

    await db.collection("Appointments").updateOne(
      { _id: new ObjectId(appointmentId) },
      { $set: { appointmentStatus: "completed", completedAt: new Date(), updatedAt: new Date() } }
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

// =========================================================================
// GET: FEATURED REVIEWS for Homepage
// =========================================================================
router.get("/reviews/featured", async (req, res) => {
  try {
    const db = await connectToDatabase();
    const limitNum = Math.min(20, Math.max(1, Number(req.query.limit) || 6));
    const minRatingNum = Number(req.query.minRating) || 4;

    const reviews = await db.collection("Reviews").aggregate([
      {
        $match: {
          rating: { $gte: minRatingNum },
          reviewText: { $exists: true, $ne: "" }
        }
      },
      { $sort: { rating: -1, createdAt: -1 } },
      { $limit: limitNum },
      {
        $lookup: {
          from: "Doctor",
          localField: "doctorId",
          foreignField: "_id",
          as: "doctorInfo"
        }
      },
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
          doctorInfo: { $arrayElemAt: ["$doctorInfo", 0] },
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
          patientName: {
            $ifNull: ["$appointmentInfo.patientName", "$appointmentInfo.name", "Anonymous Patient"]
          },
          doctorName: "$doctorInfo.doctorName",
          specialization: "$doctorInfo.specialization",
          doctorImage: "$doctorInfo.image"
        }
      }
    ]).toArray();

    res.status(200).json({ 
      success: true, 
      reviews: reviews || [],
      count: reviews?.length || 0
    });

  } catch (error) {
    console.error("Failed to fetch featured reviews:", error);
    res.status(200).json({ 
      success: true, 
      reviews: [],
      count: 0,
      message: "No reviews available yet"
    });
  }
});

// =========================================================================
// ✅ NEW: GET DOCTOR'S REVIEWS (Only for logged-in doctor)
// =========================================================================
router.get("/reviews/:doctorEmail", async (req, res) => {
  try {
    const db = await connectToDatabase();
    const doctorEmail = req.params.doctorEmail.toLowerCase();

    // ✅ Verify doctor exists
    const doctor = await db.collection("Doctor").findOne({ 
      email: doctorEmail 
    });

    if (!doctor) {
      return res.status(404).json({ 
        success: false, 
        message: "Doctor not found." 
      });
    }

    // ✅ Get ONLY this doctor's reviews with patient info
    const reviews = await db.collection("Reviews").aggregate([
      {
        $match: { 
          doctorId: doctor._id 
        }
      },
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
          appointmentInfo: { $arrayElemAt: ["$appointmentInfo", 0] }
        }
      },
      {
        $project: {
          _id: 1,
          rating: 1,
          reviewText: 1,
          createdAt: 1,
          patientName: 1,
          patientEmail: 1,
          doctorId: 1,
          appointmentId: 1,
          // ✅ Include appointment details
          appointmentDate: "$appointmentInfo.appointmentDate",
          appointmentTime: "$appointmentInfo.appointmentTime",
          patientName: {
            $ifNull: ["$patientName", "$appointmentInfo.patientName", "Anonymous Patient"]
          }
        }
      },
      { $sort: { createdAt: -1 } }
    ]).toArray();

    // ✅ Calculate average rating for this doctor
    const avgRatingResult = await db.collection("Reviews").aggregate([
      { $match: { doctorId: doctor._id } },
      { $group: { _id: null, avg: { $avg: "$rating" } } }
    ]).toArray();

    const avgRating = avgRatingResult[0]?.avg 
      ? parseFloat(avgRatingResult[0].avg.toFixed(1)) 
      : 0;

    res.status(200).json({ 
      success: true, 
      reviews: reviews || [],
      avgRating,
      totalReviews: reviews.length,
      doctorName: doctor.doctorName,
      specialization: doctor.specialization
    });

  } catch (error) {
    console.error("Fetch doctor reviews error:", error);
    res.status(500).json({ 
      success: false, 
      message: "Failed to fetch reviews." 
    });
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

    const doctor = await db.collection("Doctor").findOne({ 
      email: doctorEmail.toLowerCase() 
    });
    
    if (!doctor) {
      return res.status(404).json({ success: false, message: "Doctor not found." });
    }

    // Check for duplicate
    const existing = await db.collection("DoctorSchedule").findOne({
      doctorId: doctor._id,
      dayOfWeek,
      startTime,
      endTime,
      isActive: true
    });

    if (existing) {
      return res.status(400).json({ 
        success: false, 
        message: "This time slot already exists for this day" 
      });
    }

    const result = await db.collection("DoctorSchedule").insertOne({
      doctorId: doctor._id,
      doctorEmail: doctorEmail.toLowerCase(),
      dayOfWeek,
      startTime,
      endTime,
      isActive: true,
      createdAt: new Date(),
      updatedAt: new Date()
    });

    // Update doctor's availableSlots
    const schedules = await db.collection("DoctorSchedule")
      .find({ doctorId: doctor._id, isActive: true })
      .toArray();

    const availableSlots = schedules.map(s => `${s.dayOfWeek}: ${s.startTime} - ${s.endTime}`);
    
    await db.collection("Doctor").updateOne(
      { _id: doctor._id },
      { $set: { availableSlots } }
    );

    res.status(201).json({ 
      success: true, 
      scheduleId: result.insertedId,
      availableSlots 
    });
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
    const doctorEmail = req.params.doctorEmail.toLowerCase();
    
    const doctor = await db.collection("Doctor").findOne({ email: doctorEmail });
    if (!doctor) {
      return res.status(404).json({ success: false, message: "Doctor not found." });
    }

    const schedules = await db.collection("DoctorSchedule")
      .find({ doctorId: doctor._id })
      .sort({ dayOfWeek: 1, startTime: 1 })
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
    const scheduleId = req.params.scheduleId;

    const updateData = {};
    if (dayOfWeek !== undefined) updateData.dayOfWeek = dayOfWeek;
    if (startTime !== undefined) updateData.startTime = startTime;
    if (endTime !== undefined) updateData.endTime = endTime;
    if (isActive !== undefined) updateData.isActive = isActive;
    updateData.updatedAt = new Date();

    const result = await db.collection("DoctorSchedule").updateOne(
      { _id: new ObjectId(scheduleId) },
      { $set: updateData }
    );

    if (result.matchedCount === 0) {
      return res.status(404).json({ success: false, message: "Schedule not found." });
    }

    // Update doctor's availableSlots
    const updatedSchedule = await db.collection("DoctorSchedule").findOne({ 
      _id: new ObjectId(scheduleId) 
    });
    
    if (updatedSchedule) {
      const schedules = await db.collection("DoctorSchedule")
        .find({ doctorId: updatedSchedule.doctorId, isActive: true })
        .toArray();

      const availableSlots = schedules.map(s => `${s.dayOfWeek}: ${s.startTime} - ${s.endTime}`);
      
      await db.collection("Doctor").updateOne(
        { _id: updatedSchedule.doctorId },
        { $set: { availableSlots } }
      );
    }

    res.status(200).json({ 
      success: true, 
      message: isActive !== undefined 
        ? `Schedule ${isActive ? 'enabled' : 'disabled'}` 
        : "Schedule updated"
    });
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
    const scheduleId = req.params.scheduleId;

    const schedule = await db.collection("DoctorSchedule").findOne({ 
      _id: new ObjectId(scheduleId) 
    });
    
    if (!schedule) {
      return res.status(404).json({ success: false, message: "Schedule not found." });
    }

    const result = await db.collection("DoctorSchedule").deleteOne({
      _id: new ObjectId(scheduleId)
    });

    if (result.deletedCount === 0) {
      return res.status(404).json({ success: false, message: "Schedule not found." });
    }

    // Update doctor's availableSlots
    const schedules = await db.collection("DoctorSchedule")
      .find({ doctorId: schedule.doctorId, isActive: true })
      .toArray();

    const availableSlots = schedules.map(s => `${s.dayOfWeek}: ${s.startTime} - ${s.endTime}`);
    
    await db.collection("Doctor").updateOne(
      { _id: schedule.doctorId },
      { $set: { availableSlots } }
    );

    res.status(200).json({ 
      success: true, 
      message: "Schedule deleted." 
    });
  } catch (error) {
    console.error("Delete failed:", error);
    res.status(500).json({ success: false, message: "Failed to delete schedule." });
  }
});

// =========================================================================
// POST: CREATE PRESCRIPTION
// =========================================================================
router.post("/prescriptions", async (req, res) => {
  try {
    const db = await connectToDatabase();
    const { 
      doctorId, 
      doctorEmail,
      doctorName,
      patientId, 
      patientEmail, 
      patientName,
      appointmentId, 
      diagnosis, 
      medications, 
      notes,
      followUpDate
    } = req.body;

    if (!doctorId || !patientEmail || !diagnosis) {
      return res.status(400).json({ 
        success: false, 
        message: "Doctor ID, patient email, and diagnosis are required." 
      });
    }

    const prescription = {
      doctorId: new ObjectId(doctorId),
      doctorEmail: doctorEmail || "",
      doctorName: doctorName || "",
      patientId: patientId ? new ObjectId(patientId) : null,
      patientEmail: patientEmail.toLowerCase(),
      patientName: patientName || "Patient",
      appointmentId: appointmentId ? new ObjectId(appointmentId) : null,
      diagnosis,
      medications: medications || "",
      notes: notes || "",
      followUpDate: followUpDate || null,
      status: "active",
      createdAt: new Date(),
      updatedAt: new Date()
    };

    const result = await db.collection("Prescriptions").insertOne(prescription);

    // ✅ Update appointment to mark as completed and prescribed
    if (appointmentId) {
      await db.collection("Appointments").updateOne(
        { _id: new ObjectId(appointmentId) },
        { 
          $set: { 
            appointmentStatus: "completed", 
            hasPrescription: true,
            prescriptionId: result.insertedId,
            completedAt: new Date(),
            updatedAt: new Date()
          } 
        }
      );
    }

    res.status(201).json({ 
      success: true, 
      message: "Prescription created successfully!",
      prescriptionId: result.insertedId,
      prescription
    });

  } catch (error) {
    console.error("Create prescription error:", error);
    res.status(500).json({ 
      success: false, 
      message: "Failed to create prescription.",
      error: error.message 
    });
  }
});

// =========================================================================
// GET: DOCTOR'S PRESCRIPTIONS (Only for logged-in doctor)
// =========================================================================
router.get("/prescriptions/list/:doctorEmail", async (req, res) => {
  try {
    const db = await connectToDatabase();
    const doctorEmail = req.params.doctorEmail.toLowerCase();

    // ✅ Verify doctor exists
    const doctor = await db.collection("Doctor").findOne({ 
      email: doctorEmail 
    });

    if (!doctor) {
      return res.status(404).json({ 
        success: false, 
        message: "Doctor not found." 
      });
    }

    // ✅ Get all prescriptions for this doctor
    const prescriptions = await db.collection("Prescriptions")
      .find({ doctorId: doctor._id })
      .sort({ createdAt: -1 })
      .toArray();

    res.status(200).json({ 
      success: true, 
      prescriptions: prescriptions || [],
      total: prescriptions.length
    });

  } catch (error) {
    console.error("Fetch prescriptions error:", error);
    res.status(500).json({ 
      success: false, 
      message: "Failed to fetch prescriptions." 
    });
  }
});

// =========================================================================
// GET: SINGLE PRESCRIPTION BY ID
// =========================================================================
router.get("/prescription/:prescriptionId", async (req, res) => {
  try {
    const db = await connectToDatabase();
    const prescriptionId = req.params.prescriptionId;

    const prescription = await db.collection("Prescriptions").findOne({
      _id: new ObjectId(prescriptionId)
    });

    if (!prescription) {
      return res.status(404).json({ 
        success: false, 
        message: "Prescription not found." 
      });
    }

    res.status(200).json({ 
      success: true, 
      prescription 
    });

  } catch (error) {
    console.error("Fetch prescription error:", error);
    res.status(500).json({ 
      success: false, 
      message: "Failed to fetch prescription." 
    });
  }
});

// =========================================================================
// PATCH: UPDATE PRESCRIPTION
// =========================================================================
router.patch("/prescription/:prescriptionId", async (req, res) => {
  try {
    const db = await connectToDatabase();
    const prescriptionId = req.params.prescriptionId;
    const { diagnosis, medications, notes, followUpDate, status } = req.body;

    const updateData = {};
    if (diagnosis !== undefined) updateData.diagnosis = diagnosis;
    if (medications !== undefined) updateData.medications = medications;
    if (notes !== undefined) updateData.notes = notes;
    if (followUpDate !== undefined) updateData.followUpDate = followUpDate;
    if (status !== undefined) updateData.status = status;
    updateData.updatedAt = new Date();

    const result = await db.collection("Prescriptions").updateOne(
      { _id: new ObjectId(prescriptionId) },
      { $set: updateData }
    );

    if (result.matchedCount === 0) {
      return res.status(404).json({ 
        success: false, 
        message: "Prescription not found." 
      });
    }

    const updatedPrescription = await db.collection("Prescriptions").findOne({
      _id: new ObjectId(prescriptionId)
    });

    res.status(200).json({ 
      success: true, 
      message: "Prescription updated successfully!",
      prescription: updatedPrescription
    });

  } catch (error) {
    console.error("Update prescription error:", error);
    res.status(500).json({ 
      success: false, 
      message: "Failed to update prescription." 
    });
  }
});

// =========================================================================
// DELETE: DELETE PRESCRIPTION
// =========================================================================
router.delete("/prescription/:prescriptionId", async (req, res) => {
  try {
    const db = await connectToDatabase();
    const prescriptionId = req.params.prescriptionId;

    const result = await db.collection("Prescriptions").deleteOne({
      _id: new ObjectId(prescriptionId)
    });

    if (result.deletedCount === 0) {
      return res.status(404).json({ 
        success: false, 
        message: "Prescription not found." 
      });
    }

    // ✅ Remove prescription reference from appointment
    await db.collection("Appointments").updateOne(
      { prescriptionId: new ObjectId(prescriptionId) },
      { 
        $unset: { prescriptionId: "", hasPrescription: "" },
        $set: { updatedAt: new Date() }
      }
    );

    res.status(200).json({ 
      success: true, 
      message: "Prescription deleted successfully!" 
    });

  } catch (error) {
    console.error("Delete prescription error:", error);
    res.status(500).json({ 
      success: false, 
      message: "Failed to delete prescription." 
    });
  }
});

// =========================================================================
// GET: PATIENT'S PRESCRIPTIONS (for patient portal)
// =========================================================================
router.get("/patient-prescriptions/:patientEmail", async (req, res) => {
  try {
    const db = await connectToDatabase();
    const patientEmail = req.params.patientEmail.toLowerCase();

    const prescriptions = await db.collection("Prescriptions")
      .find({ patientEmail: patientEmail })
      .sort({ createdAt: -1 })
      .toArray();

    res.status(200).json({ 
      success: true, 
      prescriptions: prescriptions || [],
      total: prescriptions.length
    });

  } catch (error) {
    console.error("Fetch patient prescriptions error:", error);
    res.status(500).json({ 
      success: false, 
      message: "Failed to fetch prescriptions." 
    });
  }
});



module.exports = router;