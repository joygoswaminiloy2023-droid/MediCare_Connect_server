const express = require("express");
const router = express.Router();
const { connectToDatabase } = require("../lib/db");
const { ObjectId } = require("mongodb");

// =========================================================================
// ✅ PUT SPECIFIC ROUTES FIRST (before generic /:appointmentId)
// =========================================================================

// =========================================================================
// GET: PATIENT'S UPCOMING APPOINTMENTS
// =========================================================================
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

// =========================================================================
// GET: PATIENT'S APPOINTMENT HISTORY
// =========================================================================
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

// =========================================================================
// GET: PAYMENT HISTORY
// =========================================================================
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

// =========================================================================
// GET: PATIENT'S FAVORITE DOCTORS
// =========================================================================
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
// POST: ADD REVIEW
// =========================================================================
router.post("/reviews", async (req, res) => {
  try {
    const db = await connectToDatabase();
    const { patientId, patientEmail, doctorId, appointmentId, rating, reviewText } = req.body;
    
    if (!doctorId || !rating || !reviewText) {
      return res.status(400).json({ success: false, message: "Doctor, rating, and review text are required." });
    }
    
    const existing = await db.collection("Reviews").findOne({
      doctorId: new ObjectId(doctorId),
      patientId: patientId ? new ObjectId(patientId) : null,
      appointmentId: appointmentId ? new ObjectId(appointmentId) : null
    });
    
    if (existing) {
      return res.status(409).json({ success: false, message: "You have already reviewed this doctor." });
    }
    
    const result = await db.collection("Reviews").insertOne({
      patientId: patientId ? new ObjectId(patientId) : null,
      patientEmail: patientEmail?.toLowerCase(),
      doctorId: new ObjectId(doctorId),
      appointmentId: appointmentId ? new ObjectId(appointmentId) : null,
      rating: Number(rating),
      reviewText,
      createdAt: new Date(),
      updatedAt: new Date()
    });
    
    res.status(201).json({ success: true, reviewId: result.insertedId });
  } catch (error) {
    res.status(500).json({ success: false, message: "Failed to add review.", error: error.message });
  }
});

// =========================================================================
// GET: PATIENT'S REVIEWS
// =========================================================================
router.get("/reviews/:patientEmail", async (req, res) => {
  try {
    const db = await connectToDatabase();
    
    const reviews = await db.collection("Reviews")
      .find({ patientEmail: req.params.patientEmail.toLowerCase() })
      .sort({ createdAt: -1 })
      .toArray();
    
    res.status(200).json({ success: true, reviews });
  } catch (error) {
    res.status(500).json({ success: false, message: "Failed to fetch reviews." });
  }
});

// =========================================================================
// PATCH: UPDATE REVIEW
// =========================================================================
router.patch("/reviews/:reviewId", async (req, res) => {
  try {
    const db = await connectToDatabase();
    const { rating, reviewText } = req.body;
    
    if (!rating || !reviewText) {
      return res.status(400).json({ success: false, message: "Rating and review text are required." });
    }
    
    await db.collection("Reviews").updateOne(
      { _id: new ObjectId(req.params.reviewId) },
      {
        $set: {
          rating: Number(rating),
          reviewText,
          updatedAt: new Date()
        }
      }
    );
    
    res.status(200).json({ success: true, message: "Review updated successfully." });
  } catch (error) {
    res.status(500).json({ success: false, message: "Failed to update review." });
  }
});

// =========================================================================
// DELETE: DELETE REVIEW
// =========================================================================
router.delete("/reviews/:reviewId", async (req, res) => {
  try {
    const db = await connectToDatabase();
    
    await db.collection("Reviews").deleteOne({
      _id: new ObjectId(req.params.reviewId)
    });
    
    res.status(200).json({ success: true, message: "Review deleted successfully." });
  } catch (error) {
    res.status(500).json({ success: false, message: "Failed to delete review." });
  }
});

// =========================================================================
// ✅ GENERIC ROUTES COME LAST
// =========================================================================

// =========================================================================
// GET: SINGLE APPOINTMENT BY ID
// =========================================================================
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

// =========================================================================
// PATCH: RESCHEDULE APPOINTMENT
// =========================================================================
router.patch("/:appointmentId/reschedule", async (req, res) => {
  try {
    const db = await connectToDatabase();
    const { newDate, newTime } = req.body;
    
    if (!newDate || !newTime) {
      return res.status(400).json({ success: false, message: "New date and time are required." });
    }
    
    await db.collection("Appointments").updateOne(
      { _id: new ObjectId(req.params.appointmentId) },
      {
        $set: {
          appointmentDate: newDate,
          appointmentTime: newTime,
          updatedAt: new Date()
        }
      }
    );
    
    res.status(200).json({ success: true, message: "Appointment rescheduled successfully." });
  } catch (error) {
    res.status(500).json({ success: false, message: "Failed to reschedule appointment." });
  }
});

// =========================================================================
// DELETE: CANCEL APPOINTMENT
// =========================================================================
router.delete("/:appointmentId/cancel", async (req, res) => {
  try {
    const db = await connectToDatabase();
    
    const appointment = await db.collection("Appointments").findOne({
      _id: new ObjectId(req.params.appointmentId)
    });
    
    if (!appointment) {
      return res.status(404).json({ success: false, message: "Appointment not found." });
    }
    
    await db.collection("Appointments").updateOne(
      { _id: new ObjectId(req.params.appointmentId) },
      {
        $set: {
          appointmentStatus: "cancelled",
          cancelledAt: new Date()
        }
      }
    );
    
    res.status(200).json({ success: true, message: "Appointment cancelled successfully." });
  } catch (error) {
    res.status(500).json({ success: false, message: "Failed to cancel appointment." });
  }
});

module.exports = router;