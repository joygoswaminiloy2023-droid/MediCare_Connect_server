const express = require("express");
const router = express.Router();
const { connectToDatabase } = require("../lib/db");
const { ObjectId } = require("mongodb");

// 
// ✅ PUT SPECIFIC ROUTES FIRST (before generic /:appointmentId)
// 

// 
// GET: PATIENT'S UPCOMING APPOINTMENTS
// 
router.get("/upcoming/:patientEmail", async (req, res) => {
  try {
    const db = await connectToDatabase();
    const today = new Date().toISOString().split("T")[0];
    
    const appointments = await db.collection("Appointments")
      .find({
        patientEmail: req.params.patientEmail.toLowerCase(),
        appointmentDate: { $gte: today },
        appointmentStatus: { $in: ["pending", "confirmed"] }
      })
      .sort({ appointmentDate: 1, appointmentTime: 1 })
      .toArray();
    
    res.status(200).json({ success: true, appointments });
  } catch (error) {
    res.status(500).json({ success: false, message: "Failed to fetch upcoming appointments." });
  }
});

// 
// GET: PATIENT'S APPOINTMENT HISTORY
// 
router.get("/history/:patientEmail", async (req, res) => {
  try {
    const db = await connectToDatabase();
    
    const appointments = await db.collection("Appointments")
      .find({ patientEmail: req.params.patientEmail.toLowerCase() })
      .sort({ createdAt: -1 })
      .toArray();
    
    res.status(200).json({ success: true, appointments });
  } catch (error) {
    res.status(500).json({ success: false, message: "Failed to fetch appointment history." });
  }
});

// 
// GET: PAYMENT HISTORY
// 
router.get("/payments/:patientEmail", async (req, res) => {
  try {
    const db = await connectToDatabase();
    
    const appointments = await db.collection("Appointments")
      .find({ patientEmail: req.params.patientEmail.toLowerCase() })
      .toArray();
    
    const appointmentIds = appointments.map(a => a._id);
    
    const payments = await db.collection("Payments")
      .find({ appointmentId: { $in: appointmentIds } })
      .sort({ createdAt: -1 })
      .toArray();
    
    const enrichedPayments = payments.map(payment => {
      const apt = appointments.find(a => a._id.toString() === payment.appointmentId.toString());
      return {
        ...payment,
        appointmentDate: apt?.appointmentDate,
        appointmentTime: apt?.appointmentTime,
        doctorName: apt?.doctorName,
        symptoms: apt?.symptoms
      };
    });
    
    res.status(200).json({ success: true, payments: enrichedPayments });
  } catch (error) {
    res.status(500).json({ success: false, message: "Failed to fetch payment history." });
  }
});

// 
// GET: PATIENT'S FAVORITE DOCTORS
// 
router.get("/favorite-doctors/:patientEmail", async (req, res) => {
  try {
    const db = await connectToDatabase();
    
    const appointments = await db.collection("Appointments")
      .find({ patientEmail: req.params.patientEmail.toLowerCase() })
      .toArray();
    
    const doctorIds = [...new Set(appointments.map(a => a.doctorId))];
    
    if (doctorIds.length === 0) {
      return res.status(200).json({ success: true, doctors: [] });
    }
    
    const doctors = await db.collection("Doctor")
      .find({ _id: { $in: doctorIds } })
      .toArray();
    
    const doctorsWithRatings = await Promise.all(
      doctors.map(async (doc) => {
        const reviews = await db.collection("Reviews")
          .find({ doctorId: doc._id })
          .toArray();
        
        const avgRating = reviews.length > 0
          ? (reviews.reduce((sum, r) => sum + Number(r.rating), 0) / reviews.length).toFixed(1)
          : 0;
        
        const appointmentCount = appointments.filter(a => a.doctorId.toString() === doc._id.toString()).length;
        
        return { ...doc, avgRating: Number(avgRating), reviewCount: reviews.length, appointmentCount };
      })
    );
    
    doctorsWithRatings.sort((a, b) => b.appointmentCount - a.appointmentCount);
    
    res.status(200).json({ success: true, doctors: doctorsWithRatings.slice(0, 5) });
  } catch (error) {
    res.status(500).json({ success: false, message: "Failed to fetch favorite doctors." });
  }
});

// =========================================================================
// ✅ FIXED: POST - ADD REVIEW with doctor name population
// =========================================================================
router.post("/reviews", async (req, res) => {
  try {
    const db = await connectToDatabase();
    const { patientId, patientEmail, patientName, doctorId, appointmentId, rating, reviewText } = req.body;
    
    if (!doctorId || !rating || !reviewText) {
      return res.status(400).json({ success: false, message: "Doctor, rating, and review text are required." });
    }
    
    // ✅ Get doctor name from Doctor collection
    const doctor = await db.collection("Doctor").findOne({
      _id: new ObjectId(doctorId)
    });
    
    const doctorName = doctor?.doctorName || "Doctor";
    
    // ✅ Check for existing review for this specific appointment
    const existing = await db.collection("Reviews").findOne({
      doctorId: new ObjectId(doctorId),
      patientEmail: patientEmail?.toLowerCase(),
      appointmentId: appointmentId ? new ObjectId(appointmentId) : null
    });
    
    if (existing) {
      return res.status(409).json({ 
        success: false, 
        message: "You have already reviewed this appointment." 
      });
    }
    
    // ✅ Check if appointment exists and is completed
    if (appointmentId) {
      const appointment = await db.collection("Appointments").findOne({
        _id: new ObjectId(appointmentId)
      });
      
      if (!appointment) {
        return res.status(404).json({ 
          success: false, 
          message: "Appointment not found." 
        });
      }
      
      if (appointment.appointmentStatus !== "completed") {
        return res.status(400).json({ 
          success: false, 
          message: "You can only review completed appointments." 
        });
      }
    }
    
    const result = await db.collection("Reviews").insertOne({
      patientId: patientId ? new ObjectId(patientId) : null,
      patientEmail: patientEmail?.toLowerCase(),
      patientName: patientName || "Anonymous Patient",
      doctorId: new ObjectId(doctorId),
      doctorName: doctorName,
      appointmentId: appointmentId ? new ObjectId(appointmentId) : null,
      rating: Number(rating),
      reviewText,
      createdAt: new Date(),
      updatedAt: new Date()
    });
    
    // ✅ Update appointment to mark as reviewed
    if (appointmentId) {
      await db.collection("Appointments").updateOne(
        { _id: new ObjectId(appointmentId) },
        { $set: { hasReview: true, reviewedAt: new Date() } }
      );
    }
    
    res.status(201).json({ 
      success: true, 
      reviewId: result.insertedId,
      message: "Review submitted successfully!"
    });
  } catch (error) {
    console.error("Add review error:", error);
    res.status(500).json({ success: false, message: "Failed to add review.", error: error.message });
  }
});

// =========================================================================
// ✅ FIXED: GET - PATIENT'S REVIEWS with populated doctor names & appointment details
// =========================================================================
router.get("/reviews/:patientEmail", async (req, res) => {
  try {
    const db = await connectToDatabase();
    const patientEmail = req.params.patientEmail.toLowerCase();

    // ✅ Use aggregation to populate doctor names and appointment details
    const reviews = await db.collection("Reviews").aggregate([
      {
        $match: { 
          patientEmail: patientEmail 
        }
      },
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
          updatedAt: 1,
          patientEmail: 1,
          patientName: 1,
          doctorId: 1,
          appointmentId: 1,
          // ✅ Populate doctor name
          doctorName: {
            $ifNull: ["$doctorInfo.doctorName", "$doctorName", "Doctor"]
          },
          doctorSpecialization: "$doctorInfo.specialization",
          doctorImage: "$doctorInfo.image",
          // ✅ Include appointment details for session-wise display
          appointmentDate: "$appointmentInfo.appointmentDate",
          appointmentTime: "$appointmentInfo.appointmentTime",
          appointmentStatus: "$appointmentInfo.appointmentStatus"
        }
      },
      { $sort: { createdAt: -1 } }
    ]).toArray();

    res.status(200).json({ 
      success: true, 
      reviews: reviews || [] 
    });
  } catch (error) {
    console.error("Fetch reviews error:", error);
    res.status(500).json({ success: false, message: "Failed to fetch reviews." });
  }
});

// =========================================================================
// ✅ FIXED: GET - UNREVIEWED COMPLETED APPOINTMENTS (Session-wise)
// =========================================================================
router.get("/unreviewed/:patientEmail", async (req, res) => {
  try {
    const db = await connectToDatabase();
    const patientEmail = req.params.patientEmail.toLowerCase();

    // ✅ Get all completed appointments
    const completedAppointments = await db.collection("Appointments")
      .find({
        patientEmail: patientEmail,
        appointmentStatus: "completed"
      })
      .sort({ appointmentDate: -1 })
      .toArray();

    // ✅ Get all reviewed appointment IDs
    const reviews = await db.collection("Reviews")
      .find({ 
        patientEmail: patientEmail,
        appointmentId: { $ne: null }
      })
      .toArray();

    const reviewedApptIds = new Set(
      reviews
        .filter(r => r.appointmentId)
        .map(r => r.appointmentId.toString())
    );

    // ✅ Filter out already reviewed appointments
    const unreviewed = completedAppointments.filter(a => {
      const apptId = a._id.toString();
      return !reviewedApptIds.has(apptId);
    });

    // ✅ Remove duplicates (same doctor, same date, same time)
    const unique = [];
    const seen = new Set();
    
    unreviewed.forEach(a => {
      const docId = a.doctorId?.toString();
      const key = `${docId}-${a.appointmentDate}-${a.appointmentTime}`;
      if (!seen.has(key) && docId) {
        seen.add(key);
        unique.push({
          doctorId: docId,
          doctorName: a.doctorName || "Doctor",
          appointmentId: a._id.toString(),
          appointmentDate: a.appointmentDate,
          appointmentTime: a.appointmentTime
        });
      }
    });

    res.status(200).json({ 
      success: true, 
      appointments: unique || [] 
    });
  } catch (error) {
    console.error("Fetch unreviewed appointments error:", error);
    res.status(500).json({ 
      success: false, 
      message: "Failed to fetch unreviewed appointments." 
    });
  }
});

// 
// PATCH: UPDATE REVIEW
// 
router.patch("/reviews/:reviewId", async (req, res) => {
  try {
    const db = await connectToDatabase();
    const { rating, reviewText } = req.body;
    
    if (!rating || !reviewText) {
      return res.status(400).json({ success: false, message: "Rating and review text are required." });
    }
    
    const result = await db.collection("Reviews").updateOne(
      { _id: new ObjectId(req.params.reviewId) },
      {
        $set: {
          rating: Number(rating),
          reviewText,
          updatedAt: new Date()
        }
      }
    );
    
    if (result.matchedCount === 0) {
      return res.status(404).json({ success: false, message: "Review not found." });
    }
    
    res.status(200).json({ success: true, message: "Review updated successfully." });
  } catch (error) {
    console.error("Update review error:", error);
    res.status(500).json({ success: false, message: "Failed to update review." });
  }
});

// 
// DELETE: DELETE REVIEW
// 
router.delete("/reviews/:reviewId", async (req, res) => {
  try {
    const db = await connectToDatabase();
    
    const review = await db.collection("Reviews").findOne({
      _id: new ObjectId(req.params.reviewId)
    });
    
    if (!review) {
      return res.status(404).json({ success: false, message: "Review not found." });
    }
    
    const result = await db.collection("Reviews").deleteOne({
      _id: new ObjectId(req.params.reviewId)
    });
    
    // ✅ Update appointment to remove review flag
    if (review.appointmentId) {
      await db.collection("Appointments").updateOne(
        { _id: review.appointmentId },
        { $set: { hasReview: false }, $unset: { reviewedAt: "" } }
      );
    }
    
    if (result.deletedCount === 0) {
      return res.status(404).json({ success: false, message: "Review not found." });
    }
    
    res.status(200).json({ success: true, message: "Review deleted successfully." });
  } catch (error) {
    console.error("Delete review error:", error);
    res.status(500).json({ success: false, message: "Failed to delete review." });
  }
});

// 
// GET: Check if patient already has pending/confirmed appointment with doctor
// 
router.get("/check-duplicate/:patientEmail/:doctorId", async (req, res) => {
  try {
    const db          = await connectToDatabase();
    const email       = req.params.patientEmail.toLowerCase();
    const doctorOid   = new ObjectId(req.params.doctorId);

    const existing = await db.collection("Appointments").findOne({
      patientEmail:      email,
      doctorId:          doctorOid,
      appointmentStatus: { $in: ["pending", "confirmed"] }
    });

    if (existing) {
      return res.status(200).json({
        success:     true,
        isDuplicate: true,
        status:      existing.appointmentStatus,
        appointment: existing
      });
    }

    res.status(200).json({ success: true, isDuplicate: false });
  } catch (error) {
    res.status(500).json({ success: false, message: "Failed to check." });
  }
});

// 
// GET: SINGLE APPOINTMENT BY ID
// 
router.get("/:appointmentId", async (req, res) => {
  try {
    const db = await connectToDatabase();
    const appointment = await db.collection("Appointments").findOne({
      _id: new ObjectId(req.params.appointmentId)
    });
    if (!appointment) return res.status(404).json({ success: false, message: "Appointment not found." });
    res.status(200).json({ success: true, appointment });
  } catch (error) {
    res.status(500).json({ success: false, message: "Failed to fetch appointment." });
  }
});

// 
// PATCH: RESCHEDULE APPOINTMENT
// 
router.patch("/:appointmentId/reschedule", async (req, res) => {
  try {
    const db = await connectToDatabase();
    const { newDate, newTime } = req.body;
    
    if (!newDate || !newTime) {
      return res.status(400).json({ success: false, message: "New date and time are required." });
    }
    
    const result = await db.collection("Appointments").updateOne(
      { _id: new ObjectId(req.params.appointmentId) },
      {
        $set: {
          appointmentDate: newDate,
          appointmentTime: newTime,
          updatedAt: new Date()
        }
      }
    );
    
    if (result.matchedCount === 0) {
      return res.status(404).json({ success: false, message: "Appointment not found." });
    }
    
    res.status(200).json({ success: true, message: "Appointment rescheduled successfully." });
  } catch (error) {
    res.status(500).json({ success: false, message: "Failed to reschedule appointment." });
  }
});

// 
// DELETE: CANCEL APPOINTMENT
// 
router.delete("/:appointmentId/cancel", async (req, res) => {
  try {
    const db = await connectToDatabase();
    
    const appointment = await db.collection("Appointments").findOne({
      _id: new ObjectId(req.params.appointmentId)
    });
    
    if (!appointment) {
      return res.status(404).json({ success: false, message: "Appointment not found." });
    }
    
    // ✅ Only allow cancellation if pending or confirmed
    if (!["pending", "confirmed"].includes(appointment.appointmentStatus)) {
      return res.status(400).json({ 
        success: false, 
        message: `Cannot cancel appointment with status: ${appointment.appointmentStatus}` 
      });
    }
    
    await db.collection("Appointments").updateOne(
      { _id: new ObjectId(req.params.appointmentId) },
      {
        $set: {
          appointmentStatus: "cancelled",
          cancelledAt: new Date(),
          updatedAt: new Date()
        }
      }
    );
    
    res.status(200).json({ success: true, message: "Appointment cancelled successfully." });
  } catch (error) {
    console.error("Cancel appointment error:", error);
    res.status(500).json({ success: false, message: "Failed to cancel appointment." });
  }
});

module.exports = router;