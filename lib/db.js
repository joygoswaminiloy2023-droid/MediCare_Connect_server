const { MongoClient } = require("mongodb");
require("dotenv").config();

const uri = process.env.MONGO_DB_URI;
if (!uri) {
  console.error("CRITICAL ERROR: MONGO_DB_URI is undefined in your environment variables.");
  process.exit(1);
}

let cachedDb = null;

async function connectToDatabase() {
 
  if (cachedDb) return cachedDb;

  try {
    const client = new MongoClient(uri);
    await client.connect();
    
   
    cachedDb = client.db("Medicare_connect");
    
    console.log("Connected successfully to MongoDB Atlas via Native Driver.");
    return cachedDb;
  } catch (error) {
    console.error("Failed to establish handshake connection with MongoDB Atlas:", error);
    throw error;
  }
}

module.exports = { connectToDatabase };