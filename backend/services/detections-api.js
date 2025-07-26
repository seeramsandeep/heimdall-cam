const express = require('express');
const { firestore } = require('../config/firebase');

const router = express.Router();

/**
 * GET /api/detections
 * Returns all detections from nested `detections` collections, sorted by timestamp descending
 */
router.get('/detections', async (req, res) => {
  try {
    if (!firestore) {
      return res.status(500).json({
        success: false,
        error: 'Firebase not initialized'
      });
    }

    const snapshot = await firestore
      .collectionGroup('detections')  // Search all nested detections
      .get();

    if (snapshot.empty) {
      return res.json({
        success: true,
        data: [],
        count: 0,
        message: 'No detections found'
      });
    }

    // Extract and build detection array
    const detections = [];
    snapshot.forEach(doc => {
      detections.push({
        id: doc.id,
        parentPath: doc.ref.parent.parent?.path || null,
        ...doc.data()
      });
    });

    // 🔽 Sort by timestamp._seconds descending (latest first)
    detections.sort((a, b) => {
      const aTime = a.timestamp?._seconds || 0;
      const bTime = b.timestamp?._seconds || 0;
      return bTime - aTime;
    });

    res.json({
      success: true,
      data: detections,
      count: detections.length,
      message: `Retrieved ${detections.length} detections (sorted by timestamp)`
    });

  } catch (error) {
    if (error.code === 9) {
      console.error('⚠️ Firestore index required for `timestamp`. Create it in Firebase console.');
    }

    console.error('Error fetching detections:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to fetch detections',
      details: error.message
    });
  }
});

module.exports = router;
