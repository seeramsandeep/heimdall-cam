const admin = require('firebase-admin');
require('dotenv').config();

// Initialize Firebase Admin SDK
let firebaseApp;

try {
  const serviceAccount = {
    type: "service_account",
    project_id: process.env.FIREBASE_PROJECT_ID,
    private_key_id: process.env.FIREBASE_PRIVATE_KEY_ID,
    private_key: process.env.FIREBASE_PRIVATE_KEY?.replace(/\\n/g, '\n'),
    client_email: process.env.FIREBASE_CLIENT_EMAIL,
    client_id: process.env.FIREBASE_CLIENT_ID,
    auth_uri: "https://accounts.google.com/o/oauth2/auth",
    token_uri: "https://oauth2.googleapis.com/token",
    auth_provider_x509_cert_url: "https://www.googleapis.com/oauth2/v1/certs",
    client_x509_cert_url: process.env.FIREBASE_CLIENT_CERT_URL
  };

  firebaseApp = admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
    databaseURL: process.env.FIREBASE_DATABASE_URL,
    storageBucket: process.env.FIREBASE_STORAGE_BUCKET
  });

  console.log('✅ Firebase Admin SDK initialized successfully');
} catch (error) {
  console.warn('⚠️  Firebase initialization failed:', error.message);
  console.log('📝 Make sure to set the following environment variables:');
  console.log('   - FIREBASE_PROJECT_ID');
  console.log('   - FIREBASE_PRIVATE_KEY');
  console.log('   - FIREBASE_CLIENT_EMAIL');
  console.log('   - FIREBASE_DATABASE_URL');
  console.log('   - FIREBASE_STORAGE_BUCKET');
}

// Export Firebase services
const db = firebaseApp ? admin.database() : null;
const firestore = firebaseApp ? admin.firestore() : null;
const auth = firebaseApp ? admin.auth() : null;
const storage = firebaseApp ? admin.storage() : null;
const messaging = firebaseApp ? admin.messaging() : null;

module.exports = {
  admin,
  db,
  firestore,
  auth,
  storage,
  messaging,
  isInitialized: !!firebaseApp
}; 