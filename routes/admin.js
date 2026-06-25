const express = require("express");
const router = express.Router();
const { connectToDatabase } = require("../lib/db");
const { ObjectId } = require("mongodb");

function toObjectId(id) {
  try {
    return new ObjectId(id);
  } catch {
    return null;
  }
}

// =========================================================================
// 1. ANALYTICS & RECHARTS DATA ENGINE
// =========================================================================
router.get("/analytics", async (req, res) => {
  try {
    const db = await connectToDatabase();

    const totalPatients = await db.collection("user").countDocuments({ role: "patient" });
    const totalDoctors = await db.collection("Doctor").countDocuments();
    const totalAppointments = await db.collection("Appointments").countDocuments();

    // ── Get Reviews Statistics ──────────────────────────────────────────
    const totalReviews = await db.collection("Reviews").countDocuments();

    // Calculate average rating
    const avgRatingResult = await db.collection("Reviews").aggregate([
      { $group: { _id: null, averageRating: { $avg: "$rating" } } }
    ]).toArray();

    const averageRating = avgRatingResult.length > 0
      ? parseFloat(avgRatingResult[0].averageRating.toFixed(1))
      : 0;

    // Get recent reviews (last 30 days)
    const thirtyDaysAgo = new Date();
    thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);

    const recentReviews = await db.collection("Reviews").countDocuments({
      createdAt: { $gte: thirtyDaysAgo }
    });

    // Get previous month reviews for growth calculation
    const sixtyDaysAgo = new Date();
    sixtyDaysAgo.setDate(sixtyDaysAgo.getDate() - 60);

    const previousMonthReviews = await db.collection("Reviews").countDocuments({
      createdAt: {
        $gte: sixtyDaysAgo,
        $lt: thirtyDaysAgo
      }
    });

    // Calculate review growth percentage
    let reviewGrowth = "+0%";
    if (previousMonthReviews > 0) {
      const growth = ((recentReviews - previousMonthReviews) / previousMonthReviews) * 100;
      reviewGrowth = `${growth >= 0 ? '+' : ''}${Math.round(growth)}%`;
    } else if (recentReviews > 0) {
      reviewGrowth = "+100%";
    }

    // ── Doctor Performance from Reviews ────────────────────────────────
    let doctorPerformance = [];
    try {
      doctorPerformance = await db.collection("Reviews").aggregate([
        {
          $group: {
            _id: "$doctorId",
            averageRating: { $avg: { $toDouble: "$rating" } },
            totalReviews: { $sum: 1 }
          }
        },
        { $sort: { averageRating: -1 } },
        { $limit: 5 }
      ]).toArray();
    } catch (e) {
      console.error("Aggregation skipped:", e.message);
    }

    const performanceWithNames = await Promise.all(
      doctorPerformance.map(async (perf) => {
        let name = "Specialist Provider";
        try {
          const oid = toObjectId(perf._id);
          if (oid) {
            const doc = await db.collection("Doctor").findOne({ _id: oid });
            if (doc) name = doc.doctorName;
          }
        } catch {}
        return {
          name,
          rating: parseFloat(perf.averageRating.toFixed(1)),
          reviews: perf.totalReviews
        };
      })
    );

    const finalPerformanceData = performanceWithNames.length > 0 ? performanceWithNames : [
      { name: "Dr. Tahmina Akter", rating: 4.9, reviews: 124 },
      { name: "Dr. Mahbuba Rahman", rating: 4.8, reviews: 98 },
      { name: "Dr. Shirin Akhter", rating: 4.7, reviews: 110 },
      { name: "Dr. Anisur Rahman", rating: 4.6, reviews: 85 }
    ];

    // ── Response ────────────────────────────────────────────────────────
    res.status(200).json({
      stats: [
        { id: 1, name: "Total Patients", value: totalPatients, change: "+12%", changeType: "increase" },
        { id: 2, name: "Total Doctors", value: totalDoctors, change: "+4%", changeType: "increase" },
        { id: 3, name: "Total Appointments", value: totalAppointments, change: "+22%", changeType: "increase" },
        {
          id: 4,
          name: "Reviews Received",
          value: totalReviews,
          change: reviewGrowth,
          changeType: "increase"
        },
      ],
      performanceData: finalPerformanceData,
      reviewStats: {
        total: totalReviews,
        averageRating: averageRating,
        recentReviews: recentReviews,
        growth: reviewGrowth
      }
    });
  } catch (error) {
    console.error("Analytics error:", error);
    res.status(500).json({ success: false, message: "Internal Server Analytics Error" });
  }
});

// =========================================================================
// 2. MANAGE USERS
// =========================================================================
router.get("/users", async (req, res) => {
  try {
    const db = await connectToDatabase();

    // Auto-expire restrictions whose duration has passed
    await db.collection("user").updateMany(
      { status: "restricted", restrictedUntil: { $lte: new Date() } },
      { $set: { status: "active" }, $unset: { restrictedUntil: "", restrictedAt: "" } }
    );

    const users = await db.collection("user").aggregate([
      {
        $lookup: {
          from: "session",
          let: { uid: "$_id", uidStr: { $toString: "$_id" } },
          pipeline: [
            { $match: { $expr: { $or: [{ $eq: ["$userId", "$$uid"] }, { $eq: ["$userId", "$$uidStr"] }] } } },
            { $sort: { createdAt: -1 } },
            { $limit: 1 },
            { $project: { createdAt: 1, _id: 0 } }
          ],
          as: "lastSession"
        }
      },
      {
        $lookup: {
          from: "Appointments",
          let: { uid: "$_id", uidStr: { $toString: "$_id" } },
          pipeline: [
            { $match: { $expr: { $or: [{ $eq: ["$patientId", "$$uid"] }, { $eq: ["$patientId", "$$uidStr"] }] } } },
            { $count: "total" }
          ],
          as: "appointmentStats"
        }
      },
      {
        $addFields: {
          lastLogin: { $arrayElemAt: ["$lastSession.createdAt", 0] },
          appointmentCount: { $ifNull: [{ $arrayElemAt: ["$appointmentStats.total", 0] }, 0] }
        }
      },
      { $unset: ["password", "lastSession", "appointmentStats"] }
    ]).toArray();

    res.status(200).json(users);
  } catch (error) {
    console.error("Users aggregation error:", error);
    res.status(500).json({ success: false, message: "Failed to map user directory" });
  }
});

// Temporary restriction
router.patch("/users/restrict/:id", async (req, res) => {
  try {
    const db = await connectToDatabase();
    const oid = toObjectId(req.params.id);
    if (!oid) return res.status(400).json({ success: false, message: "Invalid user ID." });

    const days = Number(req.body?.days);
    if (!days || days <= 0) return res.status(400).json({ success: false, message: "Invalid restriction duration." });

    const restrictedUntil = new Date(Date.now() + days * 24 * 60 * 60 * 1000);

    const result = await db.collection("user").updateOne(
      { _id: oid },
      { $set: { status: "restricted", restrictedUntil, restrictedAt: new Date() } }
    );
    if (result.matchedCount === 0) return res.status(404).json({ success: false, message: "User not found." });

    res.status(200).json({ success: true, status: "restricted", restrictedUntil });
  } catch (error) {
    res.status(500).json({ success: false, message: "Error restricting user." });
  }
});

// Permanent ban
router.patch("/users/ban/:id", async (req, res) => {
  try {
    const db = await connectToDatabase();
    const oid = toObjectId(req.params.id);
    if (!oid) return res.status(400).json({ success: false, message: "Invalid user ID." });

    const result = await db.collection("user").updateOne(
      { _id: oid },
      { $set: { status: "banned", bannedAt: new Date() }, $unset: { restrictedUntil: "", restrictedAt: "" } }
    );
    if (result.matchedCount === 0) return res.status(404).json({ success: false, message: "User not found." });

    res.status(200).json({ success: true, status: "banned" });
  } catch (error) {
    res.status(500).json({ success: false, message: "Error banning user." });
  }
});

// Undo / Restore user
router.patch("/users/restore/:id", async (req, res) => {
  try {
    const db = await connectToDatabase();
    const oid = toObjectId(req.params.id);
    if (!oid) return res.status(400).json({ success: false, message: "Invalid user ID." });

    const result = await db.collection("user").updateOne(
      { _id: oid },
      { $set: { status: "active" }, $unset: { restrictedUntil: "", restrictedAt: "", bannedAt: "" } }
    );
    if (result.matchedCount === 0) return res.status(404).json({ success: false, message: "User not found." });

    res.status(200).json({ success: true, status: "active" });
  } catch (error) {
    res.status(500).json({ success: false, message: "Error restoring user." });
  }
});

router.delete("/users/:id", async (req, res) => {
  try {
    const db = await connectToDatabase();
    const oid = toObjectId(req.params.id);
    if (!oid) return res.status(400).json({ success: false, message: "Invalid user ID." });

    const result = await db.collection("user").deleteOne({ _id: oid });
    res.status(200).json({ success: result.deletedCount === 1 });
  } catch (error) {
    res.status(500).json({ success: false, message: "Failed to delete user." });
  }
});

// =========================================================================
// 3. MANAGE MEDICAL PRACTITIONERS
// =========================================================================
router.get("/doctors", async (req, res) => {
  try {
    const db = await connectToDatabase();

    const approvedDoctors = await db.collection("Doctor").find({}).toArray();
    const pendingApplications = await db.collection("DoctorApplications").find({}).toArray();

    const formattedApproved = approvedDoctors.map(doc => ({
      ...doc,
      doctorName: doc.doctorName || doc.name || "Anonymous Specialist",
      hospitalName: doc.hospitalName || doc.hospital || "General Practice",
      verificationStatus: "verified"
    }));

    const formattedPending = pendingApplications.map(app => ({
      ...app,
      doctorName: app.doctorName || app.name || "Anonymous Specialist",
      hospitalName: app.hospitalName || app.hospital || "General Practice",
      verificationStatus: app.verificationStatus || "pending"
    }));

    res.status(200).json([...formattedPending, ...formattedApproved]);
  } catch (error) {
    console.error("Error fetching practitioners:", error);
    res.status(500).json({ success: false, message: "Error fetching practitioners." });
  }
});

// =========================================================================
// FIXED: Approve/Revoke doctor verification with ADMIN OVERRIDE
// _id is preserved across the DoctorApplications <-> Doctor move so the
// frontend's optimistic state updates (and any downstream lookups like
// Appointments.doctorId) keep pointing at the right document.
// =========================================================================
router.patch("/doctors/verify/:id", async (req, res) => {
  try {
    const db = await connectToDatabase();
    const { verified } = req.body;
    const docId = req.params.id;

    // ✅ ADMIN OVERRIDE: This endpoint is ADMIN-ONLY
    // No doctor session checks should happen here
    // The admin authentication middleware should already verify admin role

    const oid = toObjectId(docId);
    if (!oid) {
      return res.status(400).json({ success: false, message: "Invalid doctor ID format." });
    }

    if (verified === true) {
      // ─── APPROVE: Move from DoctorApplications to Doctor ────────────
      const application = await db.collection("DoctorApplications").findOne({ _id: oid });

      if (!application) {
        return res.status(404).json({
          success: false,
          message: "Pending application not found. It may have already been approved."
        });
      }

      // Check if doctor already exists in Doctor collection
      const existingDoctor = await db.collection("Doctor").findOne({
        email: application.email
      });

      if (existingDoctor) {
        return res.status(409).json({
          success: false,
          message: "This doctor is already approved and live."
        });
      }

      // Keep the original _id so the doctor's identity stays stable
      // across application -> live -> revoked -> reapproved cycles.
      const { createdAt, ...applicationData } = application;

      await db.collection("Doctor").insertOne({
        ...applicationData, // includes the original _id
        verificationStatus: "verified",
        isLive: true,
        approvedAt: new Date(),
        createdAt: createdAt || new Date()
      });

      // Remove from applications
      await db.collection("DoctorApplications").deleteOne({ _id: oid });

      return res.status(200).json({
        success: true,
        message: "Doctor approved and now live.",
        action: "approved"
      });

    } else {
      // ─── REVOKE: Doctor (live) → DoctorApplications (staging) ──────

      // First check if doctor exists and is live
      const liveDoctor = await db.collection("Doctor").findOne({ _id: oid });

      if (!liveDoctor) {
        return res.status(404).json({
          success: false,
          message: "Live doctor record not found."
        });
      }

      // Check if doctor is already in pending applications
      const existingApplication = await db.collection("DoctorApplications").findOne({
        email: liveDoctor.email
      });

      if (existingApplication) {
        return res.status(409).json({
          success: false,
          message: "This doctor already has a pending application."
        });
      }

      // Check if doctor has active appointments
      const activeAppointments = await db.collection("Appointments").countDocuments({
        doctorId: oid,
        appointmentStatus: { $in: ["pending", "confirmed"] }
      });

      if (activeAppointments > 0) {
        return res.status(409).json({
          success: false,
          message: `Cannot revoke verification. Doctor has ${activeAppointments} active appointment(s). Cancel them first.`
        });
      }

      // Keep the original _id here too.
      const { createdAt, ...doctorData } = liveDoctor;

      // Move to applications with pending status
      await db.collection("DoctorApplications").insertOne({
        ...doctorData, // includes the original _id
        verificationStatus: "pending",
        revokedAt: new Date(),
        createdAt: createdAt || new Date()
      });

      // Remove from live doctors
      await db.collection("Doctor").deleteOne({ _id: oid });

      return res.status(200).json({
        success: true,
        message: "Verification revoked. Doctor moved to pending applications.",
        action: "revoked"
      });
    }

  } catch (error) {
    console.error("Verification toggle failure:", error);
    res.status(500).json({
      success: false,
      message: "Failed to alter certification status.",
      error: error.message
    });
  }
});

// =========================================================================
// Force revoke verification (admin override - bypasses appointment checks)
// _id preserved here too. Since this is an upsert matched by email (not by
// _id), _id can only be set on INSERT (via $setOnInsert) — if it were put
// in $set and an existing application document with a different _id
// already matched by email, MongoDB would reject the update for trying to
// alter an immutable _id field.
// =========================================================================
router.patch("/doctors/force-revoke/:id", async (req, res) => {
  try {
    const db = await connectToDatabase();
    const docId = req.params.id;
    const { force = false } = req.body;

    const oid = toObjectId(docId);
    if (!oid) {
      return res.status(400).json({ success: false, message: "Invalid doctor ID format." });
    }

    // Get the live doctor
    const liveDoctor = await db.collection("Doctor").findOne({ _id: oid });

    if (!liveDoctor) {
      return res.status(404).json({
        success: false,
        message: "Live doctor record not found."
      });
    }

    // Force delete even if there are appointments.
    // _id is stripped out of doctorData because it can't go in $set on an
    // upsert (immutable field). It's reattached via $setOnInsert below.
    const { _id, createdAt, ...doctorData } = liveDoctor;

    // Move to applications
    await db.collection("DoctorApplications").updateOne(
      { email: doctorData.email },
      {
        $set: {
          ...doctorData,
          verificationStatus: "pending",
          revokedAt: new Date(),
          forceRevoked: true,
          forceRevokedAt: new Date()
        },
        $setOnInsert: { _id: oid, createdAt: createdAt || new Date() }
      },
      { upsert: true }
    );

    // Remove from live doctors
    await db.collection("Doctor").deleteOne({ _id: oid });

    return res.status(200).json({
      success: true,
      message: "Verification force-revoked successfully.",
      action: "force_revoked"
    });

  } catch (error) {
    console.error("Force revoke failed:", error);
    res.status(500).json({
      success: false,
      message: "Failed to force revoke verification.",
      error: error.message
    });
  }
});

// =========================================================================
// Force approve doctor (admin override)
// Same _id-preservation rule as force-revoke: only safe to set _id on
// insert, never in $set on an update of a potentially pre-existing doc.
// =========================================================================
router.patch("/doctors/force-approve/:id", async (req, res) => {
  try {
    const db = await connectToDatabase();
    const docId = req.params.id;

    const oid = toObjectId(docId);
    if (!oid) {
      return res.status(400).json({ success: false, message: "Invalid doctor ID format." });
    }

    // Get the application
    const application = await db.collection("DoctorApplications").findOne({ _id: oid });

    if (!application) {
      return res.status(404).json({
        success: false,
        message: "Application not found."
      });
    }

    // Check if already in Doctor collection
    const existingDoctor = await db.collection("Doctor").findOne({
      email: application.email
    });

    if (existingDoctor) {
      // If exists, update it instead of creating a duplicate.
      // Strip _id from the spread — updating _id on an existing matched
      // document would throw an immutable-field error if it differs.
      const { _id: _appId, ...applicationFields } = application;

      await db.collection("Doctor").updateOne(
        { email: application.email },
        {
          $set: {
            ...applicationFields,
            verificationStatus: "verified",
            isLive: true,
            forceApproved: true,
            forceApprovedAt: new Date(),
            approvedAt: new Date()
          }
        }
      );
    } else {
      // Insert new doctor — keep the original _id since this is a fresh
      // insert and there's no immutable-field conflict.
      const { createdAt, ...applicationData } = application;
      await db.collection("Doctor").insertOne({
        ...applicationData, // includes the original _id
        verificationStatus: "verified",
        isLive: true,
        forceApproved: true,
        forceApprovedAt: new Date(),
        approvedAt: new Date(),
        createdAt: createdAt || new Date()
      });
    }

    // Remove from applications
    await db.collection("DoctorApplications").deleteOne({ _id: oid });

    return res.status(200).json({
      success: true,
      message: "Doctor force-approved successfully.",
      action: "force_approved"
    });

  } catch (error) {
    console.error("Force approve failed:", error);
    res.status(500).json({
      success: false,
      message: "Failed to force approve doctor.",
      error: error.message
    });
  }
});

// DELETE: Permanently reject a pending application
router.delete("/doctors/reject/:id", async (req, res) => {
  try {
    const db = await connectToDatabase();
    const oid = toObjectId(req.params.id);
    if (!oid) return res.status(400).json({ success: false, message: "Invalid ID." });

    const result = await db.collection("DoctorApplications").deleteOne({ _id: oid });
    res.status(200).json({ success: result.deletedCount === 1, message: "Application rejected." });
  } catch (error) {
    res.status(500).json({ success: false, message: "Failed to reject application." });
  }
});

// =========================================================================
// 4. BOOKINGS & FINANCIAL AUDITING
// =========================================================================
router.get("/appointments", async (req, res) => {
  try {
    const db = await connectToDatabase();
    const appointments = await db.collection("Appointments").find({}).toArray();

    const enrichedAppointments = await Promise.all(appointments.map(async (appt) => {
      const patient = await db.collection("user").findOne({ _id: toObjectId(appt.patientId) });
      const doctor = await db.collection("Doctor").findOne({ _id: toObjectId(appt.doctorId) });

      return {
        ...appt,
        patientName: patient?.name || "Unknown Patient",
        doctorName: doctor?.doctorName || doctor?.name || "Unassigned"
      };
    }));

    res.status(200).json(enrichedAppointments);
  } catch (error) {
    res.status(500).json({ success: false, message: "Error fetching appointments." });
  }
});

router.get("/payments", async (req, res) => {
  try {
    const db = await connectToDatabase();
    const payments = await db.collection("Payments").find({}).toArray();

    const enrichedPayments = await Promise.all(payments.map(async (payment) => {
      const patient = await db.collection("user").findOne({ _id: toObjectId(payment.patientId) });
      const doctor = await db.collection("Doctor").findOne({ _id: toObjectId(payment.doctorId) });

      return {
        ...payment,
        patientName: patient?.name || "Anonymous Patient",
        doctorName: doctor?.doctorName || doctor?.name || "Unassigned"
      };
    }));

    res.status(200).json(enrichedPayments);
  } catch (error) {
    console.error("Payment enrichment error:", error);
    res.status(500).json({ success: false, message: "Failed to fetch payments." });
  }
});

// GET: Analytics with real counts
router.get("/analytics", async (req, res) => {
  try {
    const db = await connectToDatabase();

    // ✅ Real counts from database
    const totalPatients = await db.collection("user").countDocuments({ role: "patient" });
    const totalDoctors = await db.collection("Doctor").countDocuments();
    const totalAppointments = await db.collection("Appointments").countDocuments();
    const totalReviews = await db.collection("Reviews").countDocuments();

    // Calculate average rating
    const avgRatingResult = await db.collection("Reviews").aggregate([
      { $group: { _id: null, averageRating: { $avg: "$rating" } } }
    ]).toArray();
    
    const averageRating = avgRatingResult.length > 0 
      ? parseFloat(avgRatingResult[0].averageRating.toFixed(1)) 
      : 0;

    res.status(200).json({
      success: true,
      stats: [
        { id: 1, name: "Total Patients", value: totalPatients, change: "+12%", changeType: "increase" },
        { id: 2, name: "Total Doctors", value: totalDoctors, change: "+4%", changeType: "increase" },
        { id: 3, name: "Total Appointments", value: totalAppointments, change: "+22%", changeType: "increase" },
        { id: 4, name: "Reviews Received", value: totalReviews, change: "+8%", changeType: "increase" },
      ],
      averageRating,
      totalReviews
    });
  } catch (error) {
    console.error("Analytics error:", error);
    res.status(500).json({ success: false, message: "Internal Server Analytics Error" });
  }
});

module.exports = router;