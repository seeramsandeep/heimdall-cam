const express = require('express');
const multer = require('multer');
const cors = require('cors');
const fs = require('fs-extra');
const path = require('path');
const cron = require('node-cron');
const { Storage } = require('@google-cloud/storage');
const { v4: uuidv4 } = require('uuid');

const app = express();
const PORT = process.env.PORT || 3001;

// Middleware
app.use(cors());
app.use(express.json());

// Create necessary directories
const TEMP_DIR = path.join(__dirname, 'temp');
const UPLOADS_DIR = path.join(__dirname, 'uploads');

fs.ensureDirSync(TEMP_DIR);
fs.ensureDirSync(UPLOADS_DIR);

// Initialize Google Cloud Storage
const storage = new Storage({
  keyFilename: path.join(__dirname, 'heimdall-cam.json'),
  projectId: 'heimdall-cam'
});

const bucketName = 'videouploader-heimdall';
const bucket = storage.bucket(bucketName);

// Configure multer for video uploads
const upload = multer({
  dest: TEMP_DIR,
  limits: {
    fileSize: 100 * 1024 * 1024, // 100MB limit
    files: 2 // Allow video and metadata files
  },
  fileFilter: (req, file, cb) => {
    // Accept video files and metadata JSON
    if (file.mimetype.startsWith('video/') || file.fieldname === 'metadata') {
      cb(null, true);
    } else {
      cb(new Error('Only video and metadata files are allowed!'), false);
    }
  }
});

// Configure multer to handle multiple file uploads
const uploadMultiple = upload.fields([
  { name: 'video', maxCount: 1 },
  { name: 'metadata', maxCount: 1 }
]);

// Store current recording session
let currentRecording = {
  isRecording: false,
  startTime: null,
  chunks: [],
  sessionId: null,
  metadata: null
};

// API Routes

// Health check
app.get('/health', (req, res) => {
  res.json({ 
    status: 'OK', 
    timestamp: new Date().toISOString(),
    recording: currentRecording.isRecording 
  });
});

// Start recording session
app.post('/start-recording', (req, res) => {
  try {
    if (currentRecording.isRecording) {
      console.warn('Warning: A recording was already in progress. Force-stopping to start a new one.');
      // Immediately reset the state before proceeding
      currentRecording = {
        isRecording: false,
        startTime: null,
        chunks: [],
        sessionId: null,
        metadata: null
      };
    }

    // Extract metadata from request body
    const { metadata } = req.body;
    
    currentRecording = {
      isRecording: true,
      startTime: new Date(),
      chunks: [],
      sessionId: uuidv4(),
      metadata: metadata || null
    };

    console.log(`Recording started - Session ID: ${currentRecording.sessionId}`);
    if (currentRecording.metadata) {
      console.log('Recording metadata:', JSON.stringify(currentRecording.metadata, null, 2));
    }
    
    res.json({ 
      message: 'Recording started successfully',
      sessionId: currentRecording.sessionId,
      startTime: currentRecording.startTime,
      metadata: currentRecording.metadata
    });
  } catch (error) {
    console.error('Error starting recording:', error);
    res.status(500).json({ error: 'Failed to start recording' });
  }
});

// Stop recording session
app.post('/stop-recording', async (req, res) => {
  try {
    if (!currentRecording.isRecording) {
      return res.status(400).json({ error: 'No active recording session' });
    }

    const endTime = new Date();
    const duration = endTime - currentRecording.startTime;
    const stoppedSessionId = currentRecording.sessionId;

    console.log(`Recording stopped - Session ID: ${stoppedSessionId}, Duration: ${duration}ms`);

    // Mark as not recording and process any remaining chunks
    currentRecording.isRecording = false;
    await processVideoChunks();

    // Reset recording state completely
    currentRecording = {
      isRecording: false,
      startTime: null,
      chunks: [],
      sessionId: null
    };

    res.json({ 
      message: 'Recording stopped successfully',
      sessionId: stoppedSessionId,
      duration: duration,
    });

  } catch (error) {
    console.error('Error stopping recording:', error);
    res.status(500).json({ error: 'Failed to stop recording' });
  }
});

// Upload video chunk with metadata
app.post('/upload-chunk', uploadMultiple, async (req, res) => {
  let videoFile = null;
  let metadata = null;

  try {
    // Check if we have a video file
    if (!req.files || !req.files.video || req.files.video.length === 0) {
      return res.status(400).json({ error: 'No video file provided' });
    }
    videoFile = req.files.video[0];

    // Check for metadata file
    if (req.files.metadata && req.files.metadata.length > 0) {
      try {
        const metadataPath = req.files.metadata[0].path;
        const metadataContent = await fs.readFile(metadataPath, 'utf-8');
        metadata = JSON.parse(metadataContent);
        
        // Clean up the temporary metadata file
        await fs.remove(metadataPath);
        
        // Update the current recording metadata if this is the first chunk
        if (currentRecording.chunks.length === 0 && !currentRecording.metadata) {
          currentRecording.metadata = metadata;
          console.log('Updated recording metadata from first chunk:', 
            JSON.stringify(metadata, null, 2));
        }
      } catch (error) {
        console.error('Error processing metadata:', error);
        // Don't fail the upload if metadata processing fails
      }
    }

    if (!currentRecording.isRecording) {
      // Clean up uploaded files if no active recording
      await Promise.all([
        videoFile && fs.remove(videoFile.path).catch(console.error),
        req.files.metadata && req.files.metadata[0] && 
          fs.remove(req.files.metadata[0].path).catch(console.error)
      ]);
      return res.status(400).json({ error: 'No active recording session' });
    }

    // Move the uploaded chunk from TEMP_DIR to UPLOADS_DIR for persistence
    const uniqueName = `${currentRecording.sessionId || 'unknown'}_${Date.now()}_${videoFile.originalname}`;
    const destPath = path.join(UPLOADS_DIR, uniqueName);
    await fs.move(videoFile.path, destPath, { overwrite: true });

    const chunkInfo = {
      filename: uniqueName,
      originalName: videoFile.originalname,
      path: destPath,
      size: videoFile.size,
      timestamp: new Date(),
      chunkIndex: currentRecording.chunks.length,
      metadata: metadata || undefined
    };

    currentRecording.chunks.push(chunkInfo);

    console.log(`Chunk uploaded - Session: ${currentRecording.sessionId}, ` +
      `Chunk: ${chunkInfo.chunkIndex}, Size: ${(videoFile.size / (1024 * 1024)).toFixed(2)}MB`);
    if (metadata) {
      console.log(`Chunk ${chunkInfo.chunkIndex} metadata:`, 
        JSON.stringify(metadata, null, 2));
    }

    res.json({
      message: 'Video chunk uploaded successfully',
      chunkIndex: chunkInfo.chunkIndex,
      sessionId: currentRecording.sessionId,
      metadataReceived: !!metadata
    });
  } catch (error) {
    console.error('Error uploading chunk:', error);
    
    // Clean up any uploaded files in case of error
    try {
      await Promise.all([
        videoFile && fs.remove(videoFile.path).catch(console.error),
        req.files?.metadata?.[0]?.path && 
          fs.remove(req.files.metadata[0].path).catch(console.error)
      ]);
    } catch (cleanupError) {
      console.error('Error during cleanup:', cleanupError);
    }
    
    res.status(500).json({ 
      error: 'Failed to upload video chunk',
      details: error.message 
    });
  }
});

// Get recording status
app.get('/recording-status', (req, res) => {
  res.json({
    isRecording: currentRecording.isRecording,
    sessionId: currentRecording.sessionId,
    startTime: currentRecording.startTime,
    chunksCount: currentRecording.chunks.length,
    duration: currentRecording.startTime ? new Date() - currentRecording.startTime : 0
  });
});

/**
 * Uploads a file to Google Cloud Storage with optional metadata
 * @param {string} filePath - Path to the local file to upload
 * @param {string} fileName - Destination filename in the bucket
 * @param {Object} [metadata={}] - Additional metadata to include with the file
 * @returns {Promise<string>} The destination path in the bucket
 */
async function uploadToGCP(filePath, fileName, metadata = {}) {
  try {
    // Ensure the filename is URL-safe
    const safeFileName = fileName.replace(/[^a-zA-Z0-9-_.]/g, '_');
    const destination = `videos/${new Date().toISOString().split('T')[0]}/${safeFileName}`;
    
    // Prepare metadata with defaults
    const fileMetadata = {
      metadata: {
        uploadedAt: new Date().toISOString(),
        source: 'heimdall-cam',
        ...metadata // Spread the provided metadata
      }
    };

    console.log(`Uploading ${filePath} to GCP bucket ${bucketName}/${destination}`);
    console.log('With metadata:', JSON.stringify(fileMetadata, null, 2));
    
    // Upload the file
    await bucket.upload(filePath, {
      destination: destination,
      metadata: fileMetadata,
      // Enable resumable uploads for large files
      resumable: true,
      // Set content type based on file extension
      contentType: filePath.endsWith('.mp4') ? 'video/mp4' : 
                  filePath.endsWith('.mov') ? 'video/quicktime' :
                  'application/octet-stream'
    });

    console.log(`Successfully uploaded ${fileName} to GCP bucket: ${bucketName}/${destination}`);
    return destination;
  } catch (error) {
    console.error('Error uploading to GCP:', error);
    // Enhance error with more context
    const enhancedError = new Error(`Failed to upload ${fileName} to GCP: ${error.message}`);
    enhancedError.originalError = error;
    enhancedError.filePath = filePath;
    enhancedError.fileName = fileName;
    enhancedError.metadata = metadata;
    throw enhancedError;
  }
}

// Function to process and upload video chunks
// async function processVideoChunks() {
//   try {
//     // if (!currentRecording.isRecording || currentRecording.chunks.length === 0) {
//     //   return;
//     // }

//     if (currentRecording.chunks.length === 0) {
//         return;
//     }
  
//     console.log(`Processing ${currentRecording.chunks.length} video chunks...`);

//     // Process each chunk
//     for (const chunk of currentRecording.chunks) {
//       try {
//         const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
//         const fileName = `heimdall-cam-${currentRecording.sessionId}-chunk-${chunk.chunkIndex}-${timestamp}.${chunk.originalName.split('.').pop()}`;
        
//         // Upload to GCP
//         await uploadToGCP(chunk.path, fileName);
        
//         // Clean up local file after successful upload
//         await fs.remove(chunk.path);
        
//         console.log(`Chunk ${chunk.chunkIndex} processed and uploaded successfully`);
//       } catch (error) {
//         console.error(`Error processing chunk ${chunk.chunkIndex}:`, error);
//       }
//     }

//     // Clear processed chunks
//     currentRecording.chunks = [];
    
//   } catch (error) {
//     console.error('Error in processVideoChunks:', error);
//   }
// }


/**
 * Processes video chunks from the uploads directory and uploads them to GCP
 * Also processes any pending chunks in memory
 */
async function processVideoChunks() {
  try {
    // Process in-memory chunks first
    if (currentRecording.chunks && currentRecording.chunks.length > 0) {
      console.log(`[${new Date().toISOString()}] Processing ${currentRecording.chunks.length} in-memory video chunks...`);
      
      // Create a copy of the chunks array to avoid modification during iteration
      const chunksToProcess = [...currentRecording.chunks];
      let processedCount = 0;
      let errorCount = 0;
      
      for (const chunk of chunksToProcess) {
        try {
          if (!chunk.processed && chunk.path) {
            const fileExists = await fs.pathExists(chunk.path);
            if (!fileExists) {
              console.warn(`[${new Date().toISOString()}] Chunk file not found: ${chunk.path}`);
              chunk.processed = true; // Mark as processed to avoid retrying
              errorCount++;
              continue;
            }
            
            const fileStats = await fs.stat(chunk.path);
            if (fileStats.size === 0) {
              console.warn(`[${new Date().toISOString()}] Chunk file is empty: ${chunk.path}`);
              chunk.processed = true; // Mark as processed to avoid retrying
              errorCount++;
              await fs.remove(chunk.path); // Clean up empty file
              continue;
            }
            
            const timestamp = chunk.timestamp || new Date();
            const chunkIndex = chunk.chunkIndex || 'unknown';
            const sessionId = currentRecording.sessionId || 'unknown';
            
            const fileName = `sessions/${sessionId}/` +
              `${new Date(timestamp).toISOString().replace(/[:.]/g, '-')}_` +
              `${chunkIndex}${chunk.filename ? path.extname(chunk.filename) : '.mp4'}`;
            
            // Add metadata to GCP metadata
            const metadata = {
              uploadedAt: new Date().toISOString(),
              source: 'heimdall-cam',
              sessionId: sessionId,
              chunkIndex: chunkIndex,
              timestamp: timestamp.toISOString(),
              ...(chunk.metadata ? { 
                deviceInfo: chunk.metadata.deviceInfo,
                cameraInfo: chunk.metadata.cameraInfo,
                viewport: chunk.metadata.viewport,
                orientation: chunk.metadata.orientation,
                recordingSettings: chunk.metadata.recordingSettings,
                location: chunk.metadata.location,
                gyro: chunk.metadata.gyro
              } : {})
            };
            
            console.log(`[${new Date().toISOString()}] Uploading chunk ${chunkIndex} (${(fileStats.size / (1024 * 1024)).toFixed(2)} MB) to GCP`);
            
            await uploadToGCP(chunk.path, fileName, metadata);
            
            // Mark as processed and clean up
            chunk.processed = true;
            await fs.remove(chunk.path);
            console.log(`[${new Date().toISOString()}] Successfully processed and uploaded chunk ${chunkIndex}`);
            processedCount++;
          }
        } catch (error) {
          errorCount++;
          console.error(`[${new Date().toISOString()}] Error processing in-memory chunk ${chunk.chunkIndex || 'unknown'}:`, error);
          
          // If we've failed multiple times, move to error directory
          chunk.retryCount = (chunk.retryCount || 0) + 1;
          if (chunk.retryCount > 3) {
            console.error(`[${new Date().toISOString()}] Max retries exceeded for chunk ${chunk.chunkIndex || 'unknown'}, moving to error directory`);
            chunk.processed = true; // Don't retry again
            
            try {
              const errorDir = path.join(UPLOADS_DIR, 'error');
              await fs.ensureDir(errorDir);
              const errorPath = path.join(errorDir, path.basename(chunk.path));
              await fs.move(chunk.path, errorPath, { overwrite: true });
              console.error(`[${new Date().toISOString()}] Moved failed chunk to: ${errorPath}`);
            } catch (moveError) {
              console.error(`[${new Date().toISOString()}] Failed to move failed chunk:`, moveError);
            }
          }
        }
      }
      
      // Log processing summary
      console.log(`[${new Date().toISOString()}] Processed ${processedCount} chunks with ${errorCount} errors`);
      
      // Remove processed chunks from memory
      const beforeCount = currentRecording.chunks.length;
      currentRecording.chunks = currentRecording.chunks.filter(chunk => !chunk.processed);
      const removedCount = beforeCount - currentRecording.chunks.length;
      
      if (removedCount > 0) {
        console.log(`[${new Date().toISOString()}] Removed ${removedCount} processed chunks from memory`);
      }
    }

    // Process any remaining files in the uploads directory
    let uploadProcessed = 0;
    let uploadErrors = 0;
    
    try {
      const uploadFiles = (await fs.readdir(UPLOADS_DIR))
        .filter(file => {
          const ext = path.extname(file).toLowerCase();
          return ['.mp4', '.mov', '.mkv', '.webm'].includes(ext);
        });
        
      if (uploadFiles.length === 0) {
        console.log(`[${new Date().toISOString()}] No pending video chunks to process in uploads directory.`);
        return;
      }
      
      console.log(`[${new Date().toISOString()}] Found ${uploadFiles.length} video chunks in uploads/ directory`);
      
      for (const file of uploadFiles) {
        const filePath = path.join(UPLOADS_DIR, file);
        
        try {
          // Check file exists and has content
          const fileStats = await fs.stat(filePath);
          if (fileStats.size === 0) {
            console.warn(`[${new Date().toISOString()}] Skipping empty file: ${file}`);
            await fs.remove(filePath);
            continue;
          }
          
          const fileExt = path.extname(file).toLowerCase();
          const baseName = path.basename(file, fileExt);
          const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
          const fileName = `sessions/unknown/${timestamp}_${baseName}${fileExt}`;
          
          console.log(`[${new Date().toISOString()}] Processing orphaned file: ${file} (${(fileStats.size / (1024 * 1024)).toFixed(2)} MB)`);
          
          const metadata = {
            uploadedAt: new Date().toISOString(),
            source: 'heimdall-cam',
            sessionId: 'unknown',
            originalFilename: file,
            fileSize: fileStats.size,
            detectedType: fileExt.replace('.', '')
          };
          
          await uploadToGCP(filePath, fileName, metadata);
          await fs.remove(filePath);
          console.log(`[${new Date().toISOString()}] Successfully processed and uploaded ${file}`);
          uploadProcessed++;
          
        } catch (error) {
          uploadErrors++;
          console.error(`[${new Date().toISOString()}] Error processing ${file}:`, error);
          
          // Move to error directory for manual inspection
          try {
            const errorDir = path.join(UPLOADS_DIR, 'error');
            await fs.ensureDir(errorDir);
            const errorPath = path.join(errorDir, `${Date.now()}_${path.basename(file)}`);
            await fs.move(filePath, errorPath, { overwrite: true });
            console.error(`[${new Date().toISOString()}] Moved failed file to error directory: ${errorPath}`);
            
            // Write error log
            const errorLogPath = `${errorPath}.error.log`;
            await fs.writeFile(errorLogPath, JSON.stringify({
              timestamp: new Date().toISOString(),
              error: error.toString(),
              stack: error.stack,
              metadata: {
                originalPath: filePath,
                size: fileStats?.size,
                mtime: fileStats?.mtime
              }
            }, null, 2));
            
          } catch (moveError) {
            console.error(`[${new Date().toISOString()}] Failed to move error file ${file}:`, moveError);
          }
        }
      }
      
      // Log summary of uploads processing
      if (uploadProcessed > 0 || uploadErrors > 0) {
        console.log(`[${new Date().toISOString()}] Processed ${uploadProcessed} upload files with ${uploadErrors} errors`);
      }
      
    } catch (error) {
      console.error(`[${new Date().toISOString()}] Error processing uploads directory:`, error);
    }
  } catch (error) {
    console.error('Error in processVideoChunks:', error);
    // Don't rethrow to allow the server to continue running
  }
}


cron.schedule('*/10 * * * * *', async () => {
  console.log('Running scheduled video processing...');
  await processVideoChunks();
});

// Cleanup function for graceful shutdown
async function cleanup() {
  try {
    console.log('Cleaning up temporary files...');
    
    // Process any remaining chunks before shutdown
    await processVideoChunks();
    
    // Clean up temp directory
    const tempFiles = await fs.readdir(TEMP_DIR);
    for (const file of tempFiles) {
      await fs.remove(path.join(TEMP_DIR, file));
    }
    
    console.log('Cleanup completed');
  } catch (error) {
    console.error('Error during cleanup:', error);
  }
}

// Handle graceful shutdown
process.on('SIGINT', async () => {
  console.log('Received SIGINT, shutting down gracefully...');
  await cleanup();
  process.exit(0);
});

process.on('SIGTERM', async () => {
  console.log('Received SIGTERM, shutting down gracefully...');
  await cleanup();
  process.exit(0);
});

// Error handling middleware
app.use((error, req, res, next) => {
  if (error instanceof multer.MulterError) {
    if (error.code === 'LIMIT_FILE_SIZE') {
      return res.status(400).json({ error: 'File too large' });
    }
  }
  
  console.error('Unhandled error:', error);
  res.status(500).json({ error: 'Internal server error' });
});

// Start server
app.listen(PORT, '0.0.0.0', () => {
  console.log(`Heimdall Cam Backend running on port ${PORT}`);
  console.log(`GCP Bucket: ${bucketName}`);
  console.log('Video processing scheduled every 10 sec');
});

module.exports = app;
