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
    fileSize: 100 * 1024 * 1024 // 100MB limit
  },
  fileFilter: (req, file, cb) => {
    // Accept video files
    if (file.mimetype.startsWith('video/')) {
      cb(null, true);
    } else {
      cb(new Error('Only video files are allowed!'), false);
    }
  }
});

// Store current recording session
let currentRecording = {
  isRecording: false,
  startTime: null,
  chunks: [],
  sessionId: null
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
        sessionId: null
      };
    }

    currentRecording = {
      isRecording: true,
      startTime: new Date(),
      chunks: [],
      sessionId: uuidv4()
    };

    console.log(`Recording started - Session ID: ${currentRecording.sessionId}`);
    
    res.json({ 
      message: 'Recording started successfully',
      sessionId: currentRecording.sessionId,
      startTime: currentRecording.startTime
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

// Upload video chunk
app.post('/upload-chunk', upload.single('video'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'No video file provided' });
    }

    if (!currentRecording.isRecording) {
      // Clean up uploaded file if no active recording
      await fs.remove(req.file.path);
      return res.status(400).json({ error: 'No active recording session' });
    }

    // Move the uploaded chunk from TEMP_DIR to UPLOADS_DIR for persistence
    const uniqueName = `${currentRecording.sessionId || 'unknown'}_${Date.now()}_${req.file.originalname}`;
    const destPath = path.join(UPLOADS_DIR, uniqueName);
    await fs.move(req.file.path, destPath, { overwrite: true });

    const chunkInfo = {
      filename: uniqueName,
      originalName: req.file.originalname,
      path: destPath,
      size: req.file.size,
      timestamp: new Date(),
      chunkIndex: currentRecording.chunks.length
    };

    currentRecording.chunks.push(chunkInfo);

    console.log(`Chunk uploaded - Session: ${currentRecording.sessionId}, Chunk: ${chunkInfo.chunkIndex}`);

    res.json({
      message: 'Video chunk uploaded successfully',
      chunkIndex: chunkInfo.chunkIndex,
      sessionId: currentRecording.sessionId
    });
  } catch (error) {
    console.error('Error uploading chunk:', error);
    res.status(500).json({ error: 'Failed to upload video chunk' });
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

// Function to upload file to GCP bucket
async function uploadToGCP(filePath, fileName) {
  try {
    const destination = `videos/${new Date().toISOString().split('T')[0]}/${fileName}`;
    
    await bucket.upload(filePath, {
      destination: destination,
      metadata: {
        metadata: {
          uploadedAt: new Date().toISOString(),
          source: 'heimdall-cam'
        }
      }
    });

    console.log(`File ${fileName} uploaded to GCP bucket: ${bucketName}/${destination}`);
    return destination;
  } catch (error) {
    console.error('Error uploading to GCP:', error);
    throw error;
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


async function processVideoChunks() {
    try {
      const uploadFiles = await fs.readdir(UPLOADS_DIR);
      if (uploadFiles.length === 0) {
        console.log('No video chunks to process.');
        return;
      }
  
      console.log(`Processing ${uploadFiles.length} video chunks from uploads/ directory...`);
  
      for (const file of uploadFiles) {
        const filePath = path.join(UPLOADS_DIR, file);
        const ext = path.extname(file);
        const baseName = path.basename(file, ext);
        const fileName = `heimdall-cam-chunk-${Date.now()}-${baseName}${ext}`;
        try {
          await uploadToGCP(filePath, fileName);
          await fs.remove(filePath);
          console.log(`Processed and uploaded ${file}`);
        } catch (error) {
          console.error(`Error processing ${file}:`, error);
        }
      }
    } catch (error) {
      console.error('Error in processVideoChunks:', error);
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
