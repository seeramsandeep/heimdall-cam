require('dotenv').config();
const express = require('express');
const axios = require('axios');

const router = express.Router();

// Configuration
const GCLOUD_PROJECT_ID = process.env.GCLOUD_PROJECT_ID || '766778819228';
const LOCATION_ID = process.env.LOCATION_ID || 'asia-east1';
const GOOGLE_CLOUD_API_KEY = process.env.GOOGLE_CLOUD_API_KEY;

// Helper function to get access token from Google Cloud
async function getAccessToken() {
  try {
    // If we have a service account key file, use it
    const { GoogleAuth } = require('google-auth-library');
    const auth = new GoogleAuth({
      keyFilename: process.env.GCLOUD_KEYFILE,
      scopes: ['https://www.googleapis.com/auth/cloud-platform']
    });
    
    const authClient = await auth.getClient();
    const accessToken = await authClient.getAccessToken();
    return accessToken.token;
  } catch (error) {
    console.error('Error getting access token:', error.message);
    throw new Error('Failed to get access token');
  }
}

// Helper function to start video annotation
async function startVideoAnnotation(gcsUri, accessToken) {
  const url = `https://videointelligence.googleapis.com/v1/videos:annotate`;
  
  const requestBody = {
    inputUri: gcsUri,
    features: ['PERSON_DETECTION'],
    locationId: LOCATION_ID,
    videoContext: {
      personDetectionConfig: {
        includeBoundingBoxes: true,
        includeAttributes: true
      }
    }
  };

  try {
    const response = await axios.post(url, requestBody, {
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${accessToken}`
      }
    });

    console.log(`🤖 Video annotation started for: ${gcsUri}`);
    console.log(`📋 Operation name: ${response.data.name}`);
    
    return response.data;
  } catch (error) {
    console.error('Error starting video annotation:', error.response?.data || error.message);
    throw new Error(`Failed to start video annotation: ${error.response?.data?.error?.message || error.message}`);
  }
}

// Helper function to poll operation status
async function pollOperationStatus(operationName, accessToken, maxWaitTime = 300000) { // 5 minutes default
  const url = `https://videointelligence.googleapis.com/v1/${operationName}`;
  const startTime = Date.now();
  const pollInterval = 5000; // 5 seconds
  
  console.log(`🔄 Starting to poll operation: ${operationName}`);
  
  while (Date.now() - startTime < maxWaitTime) {
    try {
      const response = await axios.get(url, {
        headers: {
          'Authorization': `Bearer ${accessToken}`
        }
      });

      const operation = response.data;
      console.log(`📊 Operation status check - Done: ${operation.done}`);
      
      if (operation.done) {
        if (operation.error) {
          throw new Error(`Operation failed: ${operation.error.message}`);
        }
        
        console.log(`✅ Operation completed successfully: ${operationName}`);
        return operation.response;
      }
      
      // Wait before next poll
      await new Promise(resolve => setTimeout(resolve, pollInterval));
      
    } catch (error) {
      console.error('Error polling operation status:', error.response?.data || error.message);
      throw new Error(`Failed to poll operation: ${error.response?.data?.error?.message || error.message}`);
    }
  }
  
  throw new Error(`Operation timeout: ${operationName} did not complete within ${maxWaitTime / 1000} seconds`);
}

// Main endpoint: Analyze video with gcsUri
router.post('/analyze-video-complete', async (req, res) => {
  const startTime = Date.now();
  const { gcsUri, maxWaitTime = 300000 } = req.body; // Default 5 minutes timeout
  
  console.log(`🎬 Starting complete video analysis for: ${gcsUri}`);
  
  try {
    // Validate input
    if (!gcsUri) {
      return res.status(400).json({
        success: false,
        error: 'gcsUri is required',
        example: {
          gcsUri: 'gs://your-bucket/path/to/video.mp4'
        }
      });
    }

    if (!gcsUri.startsWith('gs://')) {
      return res.status(400).json({
        success: false,
        error: 'gcsUri must start with gs://',
        provided: gcsUri
      });
    }

    // Step 1: Get access token
    console.log('🔐 Getting access token...');
    const accessToken = await getAccessToken();
    
    // Step 2: Start video annotation
    console.log('🚀 Starting video annotation...');
    const operation = await startVideoAnnotation(gcsUri, accessToken);
    
    // Step 3: Poll for completion
    console.log('⏳ Polling for completion...');
    const analysisResults = await pollOperationStatus(operation.name, accessToken, maxWaitTime);
    
    const totalTime = Date.now() - startTime;
    
    console.log(`✅ Complete video analysis finished in ${totalTime}ms for: ${gcsUri}`);
    
    // Return the complete results
    res.json({
      success: true,
      gcsUri,
      operationName: operation.name,
      analysisResults,
      processingTime: totalTime,
      completedAt: new Date().toISOString(),
      summary: {
        videoSegments: analysisResults.annotationResults?.length || 0,
        personDetections: analysisResults.annotationResults?.[0]?.personDetectionAnnotations?.length || 0,
        totalTracks: analysisResults.annotationResults?.[0]?.personDetectionAnnotations?.[0]?.tracks?.length || 0
      }
    });

  } catch (error) {
    const totalTime = Date.now() - startTime;
    console.error(`❌ Complete video analysis failed after ${totalTime}ms:`, error.message);
    
    res.status(500).json({
      success: false,
      error: error.message,
      gcsUri,
      processingTime: totalTime,
      failedAt: new Date().toISOString()
    });
  }
});

// Alternative endpoint: Just start annotation (async)
router.post('/start-video-annotation', async (req, res) => {
  const { gcsUri } = req.body;
  
  console.log(`🎬 Starting async video annotation for: ${gcsUri}`);
  
  try {
    // Validate input
    if (!gcsUri) {
      return res.status(400).json({
        success: false,
        error: 'gcsUri is required'
      });
    }

    if (!gcsUri.startsWith('gs://')) {
      return res.status(400).json({
        success: false,
        error: 'gcsUri must start with gs://'
      });
    }

    // Get access token and start annotation
    const accessToken = await getAccessToken();
    const operation = await startVideoAnnotation(gcsUri, accessToken);
    
    console.log(`✅ Video annotation started successfully for: ${gcsUri}`);
    
    res.json({
      success: true,
      gcsUri,
      operationName: operation.name,
      message: 'Video annotation started. Use the operation name to check status.',
      startedAt: new Date().toISOString(),
      checkStatusUrl: `/api/video-intelligence/check-operation-status`,
      estimatedCompletion: new Date(Date.now() + 5 * 60 * 1000).toISOString() // ~5 minutes
    });

  } catch (error) {
    console.error(`❌ Failed to start video annotation:`, error.message);
    
    res.status(500).json({
      success: false,
      error: error.message,
      gcsUri,
      failedAt: new Date().toISOString()
    });
  }
});

// Endpoint: Check operation status
router.post('/check-operation-status', async (req, res) => {
  const { operationName } = req.body;
  
  try {
    if (!operationName) {
      return res.status(400).json({
        success: false,
        error: 'operationName is required'
      });
    }

    const accessToken = await getAccessToken();
    
    const url = `https://videointelligence.googleapis.com/v1/${operationName}`;
    const response = await axios.get(url, {
      headers: {
        'Authorization': `Bearer ${accessToken}`
      }
    });

    const operation = response.data;
    
    res.json({
      success: true,
      operationName,
      done: operation.done,
      metadata: operation.metadata,
      response: operation.response,
      error: operation.error,
      checkedAt: new Date().toISOString()
    });

  } catch (error) {
    console.error(`❌ Failed to check operation status:`, error.message);
    
    res.status(500).json({
      success: false,
      error: error.message,
      operationName,
      checkedAt: new Date().toISOString()
    });
  }
});

// Endpoint: Get operation results (only if done)
router.post('/get-operation-results', async (req, res) => {
  const { operationName, poll = false, maxWaitTime = 300000 } = req.body;
  
  try {
    if (!operationName) {
      return res.status(400).json({
        success: false,
        error: 'operationName is required'
      });
    }

    const accessToken = await getAccessToken();
    
    if (poll) {
      // Poll until completion
      console.log(`🔄 Polling operation until completion: ${operationName}`);
      const results = await pollOperationStatus(operationName, accessToken, maxWaitTime);
      
      res.json({
        success: true,
        operationName,
        results,
        completedAt: new Date().toISOString()
      });
    } else {
      // Just check current status
      const url = `https://videointelligence.googleapis.com/v1/${operationName}`;
      const response = await axios.get(url, {
        headers: {
          'Authorization': `Bearer ${accessToken}`
        }
      });

      const operation = response.data;
      
      if (!operation.done) {
        return res.json({
          success: false,
          message: 'Operation not yet complete',
          operationName,
          done: false,
          metadata: operation.metadata,
          checkedAt: new Date().toISOString()
        });
      }

      if (operation.error) {
        return res.status(500).json({
          success: false,
          error: `Operation failed: ${operation.error.message}`,
          operationName,
          operationError: operation.error
        });
      }

      res.json({
        success: true,
        operationName,
        results: operation.response,
        completedAt: new Date().toISOString()
      });
    }

  } catch (error) {
    console.error(`❌ Failed to get operation results:`, error.message);
    
    res.status(500).json({
      success: false,
      error: error.message,
      operationName,
      checkedAt: new Date().toISOString()
    });
  }
});

// Health check for this module
router.get('/health', (req, res) => {
  res.json({
    success: true,
    module: 'Video Intelligence API',
    timestamp: new Date().toISOString(),
    endpoints: [
      'POST /analyze-video-complete - Complete analysis with polling',
      'POST /start-video-annotation - Start annotation (async)',
      'POST /check-operation-status - Check operation status',
      'POST /get-operation-results - Get results (with optional polling)',
      'GET /health - This endpoint'
    ],
    configuration: {
      projectId: GCLOUD_PROJECT_ID,
      locationId: LOCATION_ID,
      defaultTimeout: '300 seconds'
    }
  });
});

module.exports = router; 