const { MongoClient } = require("mongodb");
require("dotenv").config();

const uri = process.env.MONGO_DB_URI;
if (!uri) {
  console.error("❌ CRITICAL ERROR: MONGO_DB_URI is undefined in your environment variables.");
  process.exit(1);
}

let client;
let db;

async function connectToDatabase() {
  if (db) return { client, db };

  try {
    client = new MongoClient(uri);
    await client.connect();
    db = client.db("Medicare_connect");
    console.log("✅ Connected successfully to MongoDB Atlas via Native Driver.");
    return { client, db };
  } catch (error) {
    console.error("❌ Failed to establish handshake connection with MongoDB Atlas:", error);
    throw error;
  }
}

module.exports = { connectToDatabase };