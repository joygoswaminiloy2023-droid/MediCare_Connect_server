const express = require("express");
const router = express.Router();
const { connectToDatabase } = require("../lib/db");
const { ObjectId } = require("mongodb");

// =========================================================================
// PATCH: UPDATE USER PROFILE
// =========================================================================
router.patch("/profile", async (req, res) => {
  try {
    const db = await connectToDatabase();
    const { name, phone, gender, dateOfBirth } = req.body;
    
    // Get user ID from Better Auth session (you'll need to add auth middleware)
    // For now, we'll use email from request
    const userEmail = req.body.email;
    
    if (!userEmail) {
      return res.status(400).json({ success: false, message: "Email is required." });
    }

    const result = await db.collection("user").updateOne(
      { email: userEmail.toLowerCase() },
      {
        $set: {
          name: name || "",
          phone: phone || "",
          gender: gender || "",
          dateOfBirth: dateOfBirth || "",
          updatedAt: new Date()
        }
      }
    );

    if (result.matchedCount === 0) {
      return res.status(404).json({ success: false, message: "User not found." });
    }

    res.status(200).json({ success: true, message: "Profile updated successfully." });
  } catch (error) {
    console.error("Profile update error:", error);
    res.status(500).json({ success: false, message: "Failed to update profile." });
  }
});

module.exports = router;