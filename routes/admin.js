const express = require("express");
const router = express.Router();
const { connectToDatabase } = require("../lib/db");
const { ObjectId } = require("mongodb");

// ── Safe ObjectId helper — prevents crashes on malformed IDs ──────────────────
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

    const paymentRecords = await db.collection("Payments").find({}).toArray();
    const totalRevenue = paymentRecords.reduce((sum, r) => sum + (Number(r.amount) || 0), 0);

    let doctorPerformance = [];
    try {
      doctorPerformance = await db.collection("Reviews").aggregate([
        { $group: { _id: "$doctorId", averageRating: { $avg: { $toDouble: "$rating" } }, totalReviews: { $sum: 1 } } },
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
        return { name, rating: parseFloat(perf.averageRating.toFixed(1)), reviews: perf.totalReviews };
      })
    );

    const finalPerformanceData = performanceWithNames.length > 0 ? performanceWithNames : [
      { name: "Dr. Tahmina Akter", rating: 4.9, reviews: 124 },
      { name: "Dr. Mahbuba Rahman", rating: 4.8, reviews: 98 },
      { name: "Dr. Shirin Akhter", rating: 4.7, reviews: 110 },
      { name: "Dr. Anisur Rahman", rating: 4.6, reviews: 85 }
    ];

    res.status(200).json({
      stats: [
        { id: 1, name: "Total Patients", value: totalPatients, change: "+12%", changeType: "increase" },
        { id: 2, name: "Total Doctors", value: totalDoctors, change: "+4%", changeType: "increase" },
        { id: 3, name: "Total Appointments", value: totalAppointments, change: "+22%", changeType: "increase" },
        { id: 4, name: "Total Revenue", value: `$${totalRevenue}`, change: "+8%", changeType: "increase" },
      ],
      performanceData: finalPerformanceData
    });
  } catch (error) {
    console.error("Analytics error:", error);
    res.status(500).json({ success: false, message: "Internal Server Analytics Error" });
  }
});

// =========================================================================
// 2. MANAGE USERS
// =========================================================================
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

// Temporary restriction — auto-expires after `days`
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

// Undo — restores restricted or banned user back to active
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

// GET all doctors for admin panel (pending first, then verified)
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

// PATCH: Approve (verified: true) or Revoke (verified: false)
router.patch("/doctors/verify/:id", async (req, res) => {
  try {
    const db = await connectToDatabase();
    const { verified } = req.body;
    const docId = req.params.id;


    const oid = toObjectId(docId);
    if (!oid) {
      return res.status(400).json({ success: false, message: "Invalid doctor ID format." });
    }

    if (verified) {
      // APPROVE: DoctorApplications → Doctor (live)
      const application = await db.collection("DoctorApplications").findOne({ _id: oid });

      if (!application) {
        return res.status(404).json({
          success: false,
          message: "Pending application not found. It may have already been approved."
        });
      }

      const { _id, createdAt, ...applicationData } = application; // strip _id AND createdAt to avoid conflict

      await db.collection("Doctor").updateOne(
        { email: applicationData.email },
        {
          $set: { ...applicationData, verificationStatus: "verified", approvedAt: new Date() },
          $setOnInsert: { createdAt: createdAt || new Date() } // only set on first insert, no conflict
        },
        { upsert: true }
      );

      await db.collection("DoctorApplications").deleteOne({ _id: oid });

      return res.status(200).json({ success: true, message: "Doctor approved and now live." });

    } else {
      // REVOKE: Doctor (live) → DoctorApplications (staging)
      const liveDoctor = await db.collection("Doctor").findOne({ _id: oid });

      if (!liveDoctor) {
        return res.status(404).json({ success: false, message: "Live doctor record not found." });
      }

      const { _id, createdAt, ...doctorData } = liveDoctor; // strip _id AND createdAt to avoid conflict

      await db.collection("DoctorApplications").updateOne(
        { email: doctorData.email },
        {
          $set: { ...doctorData, verificationStatus: "pending", revokedAt: new Date() },
          $setOnInsert: { createdAt: createdAt || new Date() }
        },
        { upsert: true }
      );

      await db.collection("Doctor").deleteOne({ _id: oid });

      return res.status(200).json({ success: true, message: "Verification revoked." });
    }

  } catch (error) {
    console.error("Verification toggle failure:", error);
    res.status(500).json({ success: false, message: "Failed to alter certification status." });
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
    res.status(200).json(appointments);
  } catch (error) {
    res.status(500).json({ success: false, message: "Error fetching appointments." });
  }
});

router.get("/payments", async (req, res) => {
  try {
    const db = await connectToDatabase();
    const payments = await db.collection("Payments").find({}).toArray();
    res.status(200).json(payments);
  } catch (error) {
    res.status(500).json({ success: false, message: "Failed to fetch payments." });
  }
});

module.exports = router;