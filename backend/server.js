require('dotenv').config();
const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs').promises;
const { Storage } = require('@google-cloud/storage');
const videoIntelligence = require('@google-cloud/video-intelligence').v1;
const cors = require('cors');
const { v4: uuidv4 } = require('uuid');

const app = express();

// Configuration
const PORT = process.env.PORT || 3001;
const TEMP_DIR = path.join(__dirname, 'temp');
const UPLOADS_DIR = path.join(__dirname, 'uploads');
const BUCKET_NAME = process.env.GCS_BUCKET_NAME || 'videouploader-heimdall';
const GCLOUD_KEYFILE = path.join(__dirname, process.env.GCLOUD_KEYFILE || 'heimdall-cam.json');
const GCLOUD_PROJECT_ID = process.env.GCLOUD_PROJECT_ID;

// Service status flags
let GCS_ENABLED = false;
let VIDEO_AI_ENABLED = false;

console.log('🔧 Heimdall Backend v3.0 Configuration:');
console.log(`📁 Temp Directory: ${TEMP_DIR}`);
console.log(`📁 Uploads Directory: ${UPLOADS_DIR}`);
console.log(`🪣 GCS Bucket: ${BUCKET_NAME}`);
console.log(`🔑 GCS Key File: ${GCLOUD_KEYFILE}`);
console.log(`🏢 GCP Project ID: ${GCLOUD_PROJECT_ID}`);

// Ensure directories exist
Promise.all([
  fs.mkdir(TEMP_DIR, { recursive: true }),
  fs.mkdir(UPLOADS_DIR, { recursive: true })
]).catch(console.error);

// Initialize Google Cloud services
let storage, videoClient;

async function initializeGoogleCloudServices() {
  try {
    // Check if key file exists
    try {
      await fs.access(GCLOUD_KEYFILE);
      console.log('✅ GCS key file found');
    } catch (error) {
      console.log('❌ GCS key file not found at:', GCLOUD_KEYFILE);
      console.log('⚠️  GCS upload will be disabled');
      return;
    }

    if (!GCLOUD_PROJECT_ID) {
      console.log('❌ GCLOUD_PROJECT_ID environment variable not set');
      console.log('⚠️  GCS upload will be disabled');
      return;
    }

    // Initialize Storage
    storage = new Storage({
      keyFilename: GCLOUD_KEYFILE,
      projectId: GCLOUD_PROJECT_ID,
    });

    // Test bucket access
    try {
      const bucket = storage.bucket(BUCKET_NAME);
      await bucket.getMetadata();
      console.log('✅ GCS Storage initialized and bucket accessible');
      GCS_ENABLED = true;
    } catch (bucketError) {
      console.log('❌ GCS bucket access failed:', bucketError.message);
      return;
    }

    // Initialize Video Intelligence
    try {
      videoClient = new videoIntelligence.VideoIntelligenceServiceClient({
        keyFilename: GCLOUD_KEYFILE,
      });
      console.log('✅ Video Intelligence API initialized');
      VIDEO_AI_ENABLED = true;
    } catch (videoError) {
      console.log('❌ Video Intelligence initialization failed:', videoError.message);
    }

  } catch (error) {
    console.error('❌ Google Cloud services initialization failed:', error.message);
  }
}

// CORS configuration
app.use(cors({
  origin: '*',
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'ngrok-skip-browser-warning', 'Origin', 'Accept'],
  credentials: true,
  maxAge: 86400
}));

// Additional middleware for ngrok compatibility
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept, Authorization, ngrok-skip-browser-warning');
  
  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }
  
  next();
});

app.use(express.json());

// Multer configuration for temporary file storage
const upload = multer({
  dest: TEMP_DIR,
  limits: {
    fileSize: 500 * 1024 * 1024, // 500MB limit
    files: 2 // video + metadata
  },
  fileFilter: (req, file, cb) => {
    if (file.fieldname === 'video' && file.mimetype.startsWith('video/')) {
      cb(null, true);
    } else if (file.fieldname === 'metadata' && file.mimetype === 'application/json') {
      cb(null, true);
    } else {
      cb(new Error(`Invalid file type for field ${file.fieldname}: ${file.mimetype}`));
    }
  },
});

// Active recording sessions
const activeSessions = new Map();
const uploadQueue = new Map(); // Track upload status
const analysisResults = new Map(); // Store analysis results by gcsUri

// Immediate GCP upload function with presigned URL generation
async function uploadToGCPImmediately(localFilePath, gcsPath, metadata = {}) {
  if (!GCS_ENABLED) {
    console.log('⚠️  GCS disabled, skipping upload for:', gcsPath);
    return { success: false, reason: 'GCS_DISABLED' };
  }

  try {
    console.log(`📤 Starting immediate GCS upload: ${localFilePath} → gs://${BUCKET_NAME}/${gcsPath}`);
    
    const startTime = Date.now();
    const bucket = storage.bucket(BUCKET_NAME);
    const file = bucket.file(gcsPath);

    // Upload with metadata
    await bucket.upload(localFilePath, {
      destination: gcsPath,
      metadata: {
        contentType: 'video/mp4',
        cacheControl: 'public, max-age=31536000',
        metadata: {
          ...metadata,
          uploadTimestamp: new Date().toISOString(),
          originalPath: localFilePath,
          analysisStatus: 'pending' // Mark for later analysis
        }
      },
    });

    // Generate presigned URL valid for 48 hours
    const [presignedUrl] = await file.getSignedUrl({
      action: 'read',
      expires: Date.now() + 48 * 60 * 60 * 1000, // 48 hours from now
    });

    const duration = Date.now() - startTime;
    console.log(`✅ GCS upload completed in ${duration}ms: gs://${BUCKET_NAME}/${gcsPath}`);
    console.log(`🔗 Presigned URL generated (48h validity): ${presignedUrl.substring(0, 100)}...`);
    
    return { 
      success: true, 
      gcsUri: `gs://${BUCKET_NAME}/${gcsPath}`,
      presignedUrl,
      expiresAt: new Date(Date.now() + 48 * 60 * 60 * 1000).toISOString(),
      duration,
      metadata 
    };

  } catch (error) {
    console.error(`❌ GCS upload failed for ${gcsPath}:`, error.message);
    return { 
      success: false, 
      error: error.message,
      gcsPath 
    };
  }
}

// Process video for AI analysis
async function processVideoAnalysis(gcsUri, metadata) {
  if (!VIDEO_AI_ENABLED) {
    console.log('⚠️  Video AI disabled, skipping analysis for:', gcsUri);
    return null;
  }

  try {
    console.log(`🤖 Starting AI analysis for: ${gcsUri}`);
    
    const request = {
      inputUri: gcsUri,
      features: [
        'LABEL_DETECTION',
        'PERSON_DETECTION',
        'OBJECT_TRACKING',
        'TEXT_DETECTION',
      ],
      videoContext: {
        personDetectionConfig: {
          includeBoundingBoxes: true,
          includeAttributes: true,
        },
        labelDetectionConfig: {
          model: 'builtin/latest',
        },
      },
    };

    const [operation] = await videoClient.annotateVideo(request);
    const [result] = await operation.promise();
    
    console.log(`✅ AI analysis completed for: ${gcsUri}`);
    return {
      ...result.annotationResults[0],
      processedAt: new Date().toISOString(),
      metadata
    };

  } catch (error) {
    console.error(`❌ AI analysis failed for ${gcsUri}:`, error.message);
    return {
      error: error.message,
      processedAt: new Date().toISOString(),
      metadata
    };
  }
}

// Clean up local temp file after processing
async function cleanupTempFile(filePath) {
  try {
    await fs.unlink(filePath);
    console.log(`🗑️  Cleaned up temp file: ${filePath}`);
  } catch (error) {
    console.warn(`⚠️  Failed to cleanup temp file: ${filePath}`, error.message);
  }
}

// Move file to permanent storage
async function moveToUploads(tempPath, sessionId, chunkIndex, deviceId = 'unknown') {
  try {
    const deviceDir = path.join(UPLOADS_DIR, deviceId);
    const sessionDir = path.join(deviceDir, sessionId);
    await fs.mkdir(sessionDir, { recursive: true });
    
    const timestamp = new Date().toISOString().replace(/:/g, '-').split('.')[0];
    const fileName = `chunk_${chunkIndex}_${timestamp}.mp4`;
    const permanentPath = path.join(sessionDir, fileName);
    
    await fs.copyFile(tempPath, permanentPath);
    console.log(`📁 Moved to permanent storage: ${permanentPath}`);
    
    return permanentPath;
  } catch (error) {
    console.error('❌ Failed to move file to permanent storage:', error);
    throw error;
  }
}

// Monitor and upload temp files to GCP in parallel
async function uploadTempFilesToGCP() {
  if (!GCS_ENABLED) {
    console.log('⚠️  GCS disabled, skipping temp file uploads');
    return;
  }

  try {
    const tempFiles = await fs.readdir(TEMP_DIR);
    const videoFiles = tempFiles.filter(file => 
      file.endsWith('.mp4') || file.endsWith('.mov') || file.endsWith('.mkv')
    );

    if (videoFiles.length === 0) {
      return;
    }

    console.log(`📁 Found ${videoFiles.length} video files in temp directory, uploading to GCP...`);

    // Upload files in parallel
    const uploadPromises = videoFiles.map(async (filename) => {
      const localPath = path.join(TEMP_DIR, filename);
      const gcsPath = `temp-uploads/${Date.now()}-${filename}`;
      
      try {
        const result = await uploadToGCPImmediately(localPath, gcsPath, {
          source: 'temp-directory',
          originalFilename: filename,
          foundAt: new Date().toISOString()
        });

        if (result.success) {
          // Clean up local temp file after successful upload
          await cleanupTempFile(localPath);
          console.log(`✅ Temp file uploaded and cleaned: ${filename}`);
          return { filename, success: true, gcsUri: result.gcsUri };
        } else {
          console.log(`❌ Failed to upload temp file: ${filename}`, result.error);
          return { filename, success: false, error: result.error };
        }
      } catch (error) {
        console.error(`❌ Error uploading temp file ${filename}:`, error.message);
        return { filename, success: false, error: error.message };
      }
    });

    const results = await Promise.all(uploadPromises);
    const successful = results.filter(r => r.success).length;
    const failed = results.filter(r => !r.success).length;

    console.log(`📊 Temp upload results: ${successful} successful, ${failed} failed`);
    return results;

  } catch (error) {
    console.error('❌ Error scanning temp directory:', error.message);
  }
}

// Start periodic temp file monitoring
function startTempFileMonitoring() {
  if (GCS_ENABLED) {
    console.log('🔄 Starting temp file monitoring (every 30 seconds)');
    
    // Initial upload
    uploadTempFilesToGCP();
    
    // Set up periodic monitoring
    setInterval(() => {
      uploadTempFilesToGCP();
    }, 30000); // Check every 30 seconds
  }
}

// API Routes

// Health check
app.get('/health', (req, res) => {
  const analysisStats = {
    total: analysisResults.size,
    completed: Array.from(analysisResults.values()).filter(a => !a.error && !a.status).length,
    failed: Array.from(analysisResults.values()).filter(a => a.status === 'failed').length
  };

  res.json({
    status: 'healthy',
    timestamp: new Date(),
    server: 'Heimdall Backend v3.0',
    activeSessions: activeSessions.size,
    analysisResults: analysisStats,
    services: {
      gcs: {
        enabled: GCS_ENABLED,
        bucket: BUCKET_NAME,
      },
      videoAI: {
        enabled: VIDEO_AI_ENABLED,
      },
    },
    configuration: {
      tempDir: TEMP_DIR,
      uploadsDir: UPLOADS_DIR,
      port: PORT,
    }
  });
});

// Start recording session
app.post('/start-recording', (req, res) => {
  try {
    const sessionId = uuidv4();
    const session = {
      sessionId,
      startTime: new Date(),
      chunkCount: 0,
      status: 'active',
      uploads: []
    };
    
    activeSessions.set(sessionId, session);
    console.log(`🎬 Recording session started: ${sessionId}`);
    
    res.json({
      success: true,
      sessionId,
      startTime: session.startTime,
      message: 'Recording session started successfully'
    });
    
  } catch (error) {
    console.error('❌ Failed to start recording session:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// Stop recording session
app.post('/stop-recording', (req, res) => {
  try {
    const { sessionId } = req.body;
    
    if (sessionId && activeSessions.has(sessionId)) {
      const session = activeSessions.get(sessionId);
      session.status = 'stopped';
      session.endTime = new Date();
      
      console.log(`🛑 Recording session stopped: ${sessionId}`);
      
      res.json({
        success: true,
        sessionId,
        summary: {
          duration: session.endTime - session.startTime,
          chunksProcessed: session.chunkCount,
          uploads: session.uploads.length
        }
      });
    } else {
      res.json({
        success: true,
        message: 'No active session to stop'
      });
    }
    
  } catch (error) {
    console.error('❌ Failed to stop recording session:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// Upload video chunk - main endpoint
app.post('/upload-chunk', upload.fields([
  { name: 'video', maxCount: 1 },
  { name: 'metadata', maxCount: 1 }
]), async (req, res) => {
  const startTime = Date.now();
  const uploadId = uuidv4();
  
  console.log(`📥 Upload request received [${uploadId}] at ${new Date().toISOString()}`);
  
  try {
    const files = req.files;
    const videoFile = files?.video?.[0];
    const metadataFile = files?.metadata?.[0];
    
    if (!videoFile) {
      return res.status(400).json({
        success: false,
        error: 'No video file provided',
        uploadId
      });
    }

    // Parse metadata if provided
    let metadata = {};
    if (metadataFile) {
      try {
        const metadataContent = await fs.readFile(metadataFile.path, 'utf8');
        metadata = JSON.parse(metadataContent);
        console.log(`📋 Metadata parsed for upload [${uploadId}]`);
        
        // Clean up metadata temp file immediately
        await cleanupTempFile(metadataFile.path);
      } catch (metadataError) {
        console.warn(`⚠️  Failed to parse metadata for upload [${uploadId}]:`, metadataError.message);
      }
    }

    const chunkIndex = metadata.chunkIndex || Date.now();
    const sessionId = metadata.sessionId || 'unknown';
    
    console.log(`📹 Processing video chunk [${uploadId}] - Session: ${sessionId}, Chunk: ${chunkIndex}`);
    
    // Update session info
    if (activeSessions.has(sessionId)) {
      const session = activeSessions.get(sessionId);
      session.chunkCount++;
      session.lastChunkTime = new Date();
    }

    // 1. IMMEDIATE GCP UPLOAD (simultaneous with other operations)
    const deviceId = metadata.deviceId || 'unknown';
    const timestamp = new Date().toISOString().replace(/:/g, '-').split('.')[0]; // Clean timestamp
    const gcsPath = `devices/${deviceId}/sessions/${sessionId}/chunks/chunk_${chunkIndex}_${timestamp}.mp4`;
    
    // Start GCP upload immediately (don't await yet)
    const gcsUploadPromise = uploadToGCPImmediately(videoFile.path, gcsPath, metadata);
    
    // 2. SIMULTANEOUSLY move to permanent storage
    const permanentStoragePromise = moveToUploads(videoFile.path, sessionId, chunkIndex, deviceId);
    
    // 3. Wait for both operations to complete
    const [gcsResult, permanentPath] = await Promise.all([
      gcsUploadPromise,
      permanentStoragePromise
    ]);
    
    // 4. Clean up temp file after successful operations
    await cleanupTempFile(videoFile.path);
    
    // 5. Store upload info with presigned URL (no immediate AI analysis)
    if (gcsResult.success && activeSessions.has(sessionId)) {
      const session = activeSessions.get(sessionId);
      session.uploads.push({
        uploadId,
        chunkIndex,
        gcsUri: gcsResult.gcsUri,
        presignedUrl: gcsResult.presignedUrl,
        expiresAt: gcsResult.expiresAt,
        localPath: permanentPath,
        analysisStatus: 'pending', // Ready for later analysis
        timestamp: new Date()
      });
    }
    
    const totalDuration = Date.now() - startTime;
    
    console.log(`✅ Upload [${uploadId}] completed in ${totalDuration}ms`);
    console.log(`   📤 GCS Upload: ${gcsResult.success ? '✅' : '❌'} (${gcsResult.duration || 0}ms)`);
    console.log(`   📁 Local Storage: ✅`);
    console.log(`   🔗 Presigned URL: ${gcsResult.success ? '✅ 48h validity' : '❌'}`);

    // Send response with presigned URL for immediate access
    res.json({
      success: true,
      uploadId,
      sessionId,
      chunkIndex,
      gcsUpload: {
        success: gcsResult.success,
        gcsUri: gcsResult.gcsUri,
        presignedUrl: gcsResult.presignedUrl,
        expiresAt: gcsResult.expiresAt
      },
      localPath: permanentPath,
      processingTime: totalDuration,
      timestamp: new Date().toISOString(),
      message: 'Video chunk uploaded successfully with 48h access URL'
    });

  } catch (error) {
    const duration = Date.now() - startTime;
    console.error(`❌ Upload [${uploadId}] failed after ${duration}ms:`, error.message);
    
    res.status(500).json({
      success: false,
      uploadId,
      error: error.message,
      processingTime: duration,
      timestamp: new Date().toISOString()
    });
  }
});

// Get session status
app.get('/session/:sessionId', (req, res) => {
  const { sessionId } = req.params;
  
  if (activeSessions.has(sessionId)) {
    const session = activeSessions.get(sessionId);
    res.json({
      success: true,
      session: {
        ...session,
        uploads: session.uploads || []
      }
    });
  } else {
    res.status(404).json({
      success: false,
      error: 'Session not found'
    });
  }
});

// List all sessions
app.get('/sessions', (req, res) => {
  const sessions = Array.from(activeSessions.entries()).map(([id, session]) => ({
    sessionId: id,
    ...session
  }));
  
  res.json({
    success: true,
    sessions,
    total: sessions.length
  });
});

// List all uploaded videos
app.get('/videos', async (req, res) => {
  try {
    if (!GCS_ENABLED) {
      return res.status(503).json({
        success: false,
        error: 'GCS not enabled'
      });
    }

    const bucket = storage.bucket(BUCKET_NAME);
    const [files] = await bucket.getFiles({
      prefix: 'devices/', // Get all video files under devices/
    });

    const videos = await Promise.all(
      files
        .filter(file => file.name.endsWith('.mp4') || file.name.endsWith('.mov') || file.name.endsWith('.mkv'))
        .map(async (file) => {
          try {
            const [metadata] = await file.getMetadata();
            
            // Generate new presigned URL (48 hours)
            const [presignedUrl] = await file.getSignedUrl({
              action: 'read',
              expires: Date.now() + 48 * 60 * 60 * 1000,
            });

            const gcsUri = `gs://${BUCKET_NAME}/${file.name}`;
            const analysisData = analysisResults.get(gcsUri);

            return {
              filename: file.name,
              gcsUri,
              presignedUrl,
              expiresAt: new Date(Date.now() + 48 * 60 * 60 * 1000).toISOString(),
              size: metadata.size,
              created: metadata.timeCreated,
              updated: metadata.updated,
              analysisStatus: analysisData ? (analysisData.status === 'failed' ? 'failed' : 'completed') : 'pending',
              analysisCompletedAt: analysisData?.completedAt,
              deviceId: metadata.metadata?.deviceId || 'unknown',
              sessionId: file.name.split('/')[2] || 'unknown', // Extract from path
              chunkIndex: metadata.metadata?.chunkIndex || 'unknown'
            };
          } catch (error) {
            console.warn(`⚠️  Could not get metadata for ${file.name}:`, error.message);
            return {
              filename: file.name,
              gcsUri: `gs://${BUCKET_NAME}/${file.name}`,
              error: 'Metadata unavailable'
            };
          }
        })
    );

    res.json({
      success: true,
      videos: videos.filter(v => !v.error), // Only return successful ones
      total: videos.filter(v => !v.error).length,
      timestamp: new Date().toISOString()
    });

  } catch (error) {
    console.error('❌ Error listing videos:', error.message);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// Get videos by device ID
app.get('/videos/device/:deviceId', async (req, res) => {
  try {
    const { deviceId } = req.params;
    
    if (!GCS_ENABLED) {
      return res.status(503).json({
        success: false,
        error: 'GCS not enabled'
      });
    }

    const bucket = storage.bucket(BUCKET_NAME);
    const [files] = await bucket.getFiles({
      prefix: `devices/${deviceId}/`, // Filter by device ID
    });

    const videos = await Promise.all(
      files
        .filter(file => file.name.endsWith('.mp4') || file.name.endsWith('.mov') || file.name.endsWith('.mkv'))
        .map(async (file) => {
          try {
            const [metadata] = await file.getMetadata();
            
            // Generate new presigned URL (48 hours)
            const [presignedUrl] = await file.getSignedUrl({
              action: 'read',
              expires: Date.now() + 48 * 60 * 60 * 1000,
            });

            const gcsUri = `gs://${BUCKET_NAME}/${file.name}`;
            const analysisData = analysisResults.get(gcsUri);

            return {
              filename: file.name,
              gcsUri,
              presignedUrl,
              expiresAt: new Date(Date.now() + 48 * 60 * 60 * 1000).toISOString(),
              size: metadata.size,
              created: metadata.timeCreated,
              updated: metadata.updated,
              analysisStatus: analysisData ? (analysisData.status === 'failed' ? 'failed' : 'completed') : 'pending',
              analysisCompletedAt: analysisData?.completedAt,
              deviceId: metadata.metadata?.deviceId || deviceId,
              sessionId: file.name.split('/')[2] || 'unknown',
              chunkIndex: metadata.metadata?.chunkIndex || 'unknown'
            };
          } catch (error) {
            console.warn(`⚠️  Could not get metadata for ${file.name}:`, error.message);
            return {
              filename: file.name,
              gcsUri: `gs://${BUCKET_NAME}/${file.name}`,
              error: 'Metadata unavailable'
            };
          }
        })
    );

    const validVideos = videos.filter(v => !v.error);

    res.json({
      success: true,
      deviceId,
      videos: validVideos,
      total: validVideos.length,
      analysisStatus: {
        completed: validVideos.filter(v => v.analysisStatus === 'completed').length,
        pending: validVideos.filter(v => v.analysisStatus === 'pending').length,
        failed: validVideos.filter(v => v.analysisStatus === 'failed').length
      },
      timestamp: new Date().toISOString()
    });

  } catch (error) {
    console.error('❌ Error listing videos for device:', error.message);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// Get analysis results for a specific video
app.get('/analysis/:gcsUri(*)', async (req, res) => {
  try {
    const gcsUri = req.params.gcsUri;
    
    if (!gcsUri) {
      return res.status(400).json({
        success: false,
        error: 'GCS URI is required'
      });
    }

    // Reconstruct full GCS URI if needed
    const fullGcsUri = gcsUri.startsWith('gs://') ? gcsUri : `gs://${BUCKET_NAME}/${gcsUri}`;
    
    const analysisData = analysisResults.get(fullGcsUri);
    
    if (!analysisData) {
      return res.status(404).json({
        success: false,
        error: 'Analysis results not found for this video',
        gcsUri: fullGcsUri,
        message: 'Video may not have been analyzed yet. Use POST /analyze-video to start analysis.'
      });
    }

    res.json({
      success: true,
      gcsUri: fullGcsUri,
      analysis: analysisData,
      timestamp: new Date().toISOString()
    });

  } catch (error) {
    console.error('❌ Error retrieving analysis results:', error.message);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// Get all analysis results
app.get('/analysis', (req, res) => {
  try {
    const allAnalysis = Array.from(analysisResults.entries()).map(([gcsUri, data]) => ({
      gcsUri,
      ...data
    }));

    const summary = {
      total: allAnalysis.length,
      completed: allAnalysis.filter(a => !a.error && !a.status).length,
      failed: allAnalysis.filter(a => a.status === 'failed').length,
      byType: {
        manual: allAnalysis.filter(a => a.type === 'manual').length,
        bulk: allAnalysis.filter(a => a.type === 'bulk').length
      }
    };

    res.json({
      success: true,
      analysis: allAnalysis,
      summary,
      timestamp: new Date().toISOString()
    });

  } catch (error) {
    console.error('❌ Error retrieving all analysis results:', error.message);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// Trigger video analysis for specific video
app.post('/analyze-video', async (req, res) => {
  try {
    const { gcsUri, videoId } = req.body;

    if (!gcsUri) {
      return res.status(400).json({
        success: false,
        error: 'gcsUri is required'
      });
    }

    if (!VIDEO_AI_ENABLED) {
      return res.status(503).json({
        success: false,
        error: 'Video AI not enabled'
      });
    }

    const analysisId = uuidv4();
    console.log(`🤖 Starting manual analysis [${analysisId}] for: ${gcsUri}`);

    // Start analysis (fire and forget)
    processVideoAnalysis(gcsUri, { 
      analysisId,
      videoId: videoId || gcsUri,
      triggeredAt: new Date().toISOString(),
      type: 'manual'
    })
      .then(result => {
        console.log(`✅ Manual analysis completed [${analysisId}]`);
        
        // Store analysis results for later retrieval
        analysisResults.set(gcsUri, {
          analysisId,
          gcsUri,
          result,
          completedAt: new Date().toISOString(),
          type: 'manual'
        });
        
        console.log(`💾 Analysis results stored for: ${gcsUri}`);
      })
      .catch(error => {
        console.error(`❌ Manual analysis failed [${analysisId}]:`, error.message);
        
        // Store error results too
        analysisResults.set(gcsUri, {
          analysisId,
          gcsUri,
          error: error.message,
          completedAt: new Date().toISOString(),
          type: 'manual',
          status: 'failed'
        });
      });

    res.json({
      success: true,
      analysisId,
      message: 'Video analysis started',
      gcsUri,
      estimatedCompletion: new Date(Date.now() + 5 * 60 * 1000).toISOString() // ~5 minutes
    });

  } catch (error) {
    console.error('❌ Error starting video analysis:', error.message);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// Trigger bulk analysis for all pending videos
app.post('/analyze-all-videos', async (req, res) => {
  try {
    if (!VIDEO_AI_ENABLED) {
      return res.status(503).json({
        success: false,
        error: 'Video AI not enabled'
      });
    }

    if (!GCS_ENABLED) {
      return res.status(503).json({
        success: false,
        error: 'GCS not enabled'
      });
    }

    const bucket = storage.bucket(BUCKET_NAME);
    const [files] = await bucket.getFiles({
      prefix: 'devices/',
    });

    const videoFiles = files.filter(file => 
      file.name.endsWith('.mp4') || file.name.endsWith('.mov') || file.name.endsWith('.mkv')
    );

    let analysisTasks = [];
    let pendingCount = 0;

    for (const file of videoFiles) {
      try {
        const [metadata] = await file.getMetadata();
        const analysisStatus = metadata.metadata?.analysisStatus;
        
        if (analysisStatus === 'pending' || !analysisStatus) {
          const gcsUri = `gs://${BUCKET_NAME}/${file.name}`;
          const analysisId = uuidv4();
          
          analysisTasks.push({
            analysisId,
            gcsUri,
            filename: file.name
          });

          // Start analysis (fire and forget)
          processVideoAnalysis(gcsUri, {
            analysisId,
            filename: file.name,
            triggeredAt: new Date().toISOString(),
            type: 'bulk'
          })
            .then(result => {
              console.log(`✅ Bulk analysis completed [${analysisId}] for: ${file.name}`);
              
              // Store analysis results for later retrieval
              analysisResults.set(gcsUri, {
                analysisId,
                gcsUri,
                filename: file.name,
                result,
                completedAt: new Date().toISOString(),
                type: 'bulk'
              });
            })
            .catch(error => {
              console.error(`❌ Bulk analysis failed [${analysisId}] for ${file.name}:`, error.message);
              
              // Store error results too
              analysisResults.set(gcsUri, {
                analysisId,
                gcsUri,
                filename: file.name,
                error: error.message,
                completedAt: new Date().toISOString(),
                type: 'bulk',
                status: 'failed'
              });
            });

          pendingCount++;
        }
      } catch (error) {
        console.warn(`⚠️  Could not check analysis status for ${file.name}:`, error.message);
      }
    }

    res.json({
      success: true,
      message: `Started analysis for ${pendingCount} pending videos`,
      totalVideos: videoFiles.length,
      pendingAnalysis: pendingCount,
      alreadyAnalyzed: videoFiles.length - pendingCount,
      analysisTasks,
      estimatedCompletion: new Date(Date.now() + pendingCount * 2 * 60 * 1000).toISOString() // ~2 min per video
    });

  } catch (error) {
    console.error('❌ Error starting bulk analysis:', error.message);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// Debug endpoint
app.get('/debug/status', (req, res) => {
  res.json({
    timestamp: new Date(),
    activeSessions: activeSessions.size,
    services: {
      gcs: GCS_ENABLED,
      videoAI: VIDEO_AI_ENABLED
    },
    directories: {
      temp: TEMP_DIR,
      uploads: UPLOADS_DIR
    },
    server: 'Heimdall Backend v3.0'
  });
});

// Initialize and start server
async function startServer() {
  console.log('🚀 Starting Heimdall Backend v3.0...');
  
  // Initialize Google Cloud services
  await initializeGoogleCloudServices();
  
  // Start temp file monitoring
  startTempFileMonitoring();
  
  // Start the server
  app.listen(PORT, () => {
    console.log(`✅ Heimdall Backend v3.0 running on port ${PORT}`);
    console.log(`🌐 Ready to process video uploads`);
    console.log(`🔧 Services Status:`);
    console.log(`   🪣 GCS Upload: ${GCS_ENABLED ? '✅ Enabled' : '❌ Disabled'}`);
    console.log(`   🤖 Video AI: ${VIDEO_AI_ENABLED ? '✅ Enabled (Separate Analysis)' : '❌ Disabled'}`);
    console.log(`   📁 Temp Directory: ${TEMP_DIR}`);
    console.log(`   📁 Uploads Directory: ${UPLOADS_DIR}`);
    console.log(`   🔗 Presigned URLs: 48-hour validity`);
    console.log(`   🔄 Temp Monitoring: ${GCS_ENABLED ? '✅ Active (30s intervals)' : '❌ Disabled'}`);
  });
}

// Graceful shutdown
process.on('SIGTERM', () => {
  console.log('🛑 Shutting down gracefully...');
  process.exit(0);
});

// Start the server
startServer().catch(error => {
  console.error('❌ Failed to start server:', error);
  process.exit(1);
});