import React, { useRef, useState, useEffect } from 'react';
import {
  View,
  StyleSheet,
  Text,
  TouchableOpacity,
  PermissionsAndroid,
  Platform,
  Animated,
  Easing,
  Alert,
} from 'react-native';
import {
  Camera,
  useCameraDevices,
  CameraPermissionStatus,
} from 'react-native-vision-camera';
import type { Camera as CameraType } from 'react-native-vision-camera';
import RNFS from 'react-native-fs';


// Backend API configuration
// const BACKEND_URL = 'http://localhost:3001'; // Change this to your backend URL
// const BACKEND_URL = 'http://192.168.1.100:3001'; // Change this to your backend URL
// const BACKEND_URL = 'http://10.0.2.2:3001'; // Change this to your backend URL

// Ngrok URL
const BACKEND_URL = 'https://962b60825ad3.ngrok-free.app'; // Change this to your backend URL

// API functions
const apiCall = async (endpoint: string, method: string = 'GET', body?: any) => {
  try {
    const response = await fetch(`${BACKEND_URL}${endpoint}`, {
      method,
      headers: {
        'Content-Type': 'application/json',
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    return await response.json();
  } catch (error) {
    console.error('API call failed:', error);
    throw error;
  }
};

// const uploadVideoChunk = async (videoPath: string) => {
//   try {
//     const formData = new FormData();
//     formData.append('video', {
//       uri: videoPath,
//       type: 'video/mp4',
//       name: `video_${Date.now()}.mp4`,
//     } as any);

//     const response = await fetch(`${BACKEND_URL}/upload-chunk`, {
//       method: 'POST',
//       // headers: {
//       //   'Content-Type': 'multipart/form-data',
//       // },
//       body: formData,
//     });

//     return await response.json();
//   } catch (error) {
//     console.error('Video upload failed:', error);
//     throw error;
//   }
// };


function getMimeType(ext: string) {
  switch (ext.toLowerCase()) {
    case 'mp4':
      return 'video/mp4';
    case 'mov':
      return 'video/quicktime';
    case 'mkv':
      return 'video/x-matroska';
    default:
      return 'application/octet-stream';
  }
}

const uploadVideoChunk = async (videoPath: string) => {
  try {
    const ext = videoPath.split('.').pop() || 'mov';
    const mimeType = getMimeType(ext);

    const formData = new FormData();
    formData.append('video', {
      uri: Platform.OS === 'android' ? 'file://' + videoPath : videoPath,
      type: mimeType,
      name: `video_${Date.now()}.${ext}`,
    } as any);

    const response = await fetch(`${BACKEND_URL}/upload-chunk`, {
      method: 'POST',
      body: formData,
    });

    return await response.json();
  } catch (error) {
    console.error('Video upload failed:', error);
    throw error;
  }
};

export default function App() {
  const camera = useRef<CameraType>(null);
  const [hasPermission, setHasPermission] = useState(false);
  const [showCamera, setShowCamera] = useState(false);
  const [showSplash, setShowSplash] = useState(true);
  const [isRecording, setIsRecording] = useState(false);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [uploadStatus, setUploadStatus] = useState<string>('Ready');
  const recordingTimer = useRef<NodeJS.Timeout | null>(null);
  const isSegmentProcessing = useRef(false);

  // Animation for the "Open Camera" button
  const pulseAnim = useRef(new Animated.Value(1)).current;

  const devices = useCameraDevices();
  const device = devices.find(device => device.position === 'back');

  // Splash screen effect
  useEffect(() => {
    const timer = setTimeout(() => setShowSplash(false), 2000); // 2 seconds splash
    return () => clearTimeout(timer);
  }, []);

  // Button pulse animation
  useEffect(() => {
    if (!showSplash && !showCamera) {
      Animated.loop(
        Animated.sequence([
          Animated.timing(pulseAnim, {
            toValue: 1.15,
            duration: 700,
            useNativeDriver: true,
            easing: Easing.inOut(Easing.ease),
          }),
          Animated.timing(pulseAnim, {
            toValue: 1,
            duration: 700,
            useNativeDriver: true,
            easing: Easing.inOut(Easing.ease),
          }),
        ])
      ).start();
    }
  }, [showSplash, showCamera, pulseAnim]);

  // Request permissions only when opening the camera
  const requestPermissions = async () => {
    const cameraPermission: CameraPermissionStatus = await Camera.requestCameraPermission();
    const micPermission: CameraPermissionStatus = await Camera.requestMicrophonePermission();

    const granted = cameraPermission === 'granted' && micPermission === 'granted';
    setHasPermission(granted);

    if (Platform.OS === 'android' && granted) {
      await PermissionsAndroid.request(PermissionsAndroid.PERMISSIONS.RECORD_AUDIO);
    }
    return granted;
  };

  const handleOpenCamera = async () => {
    const granted = await requestPermissions();
    if (granted) {
      setShowCamera(true);
    }
  };

  // Start recording session with backend
  const handleStartRecording = async () => {
    if (!camera.current) return;
    
    try {
      // Start recording session on backend
      const response = await apiCall('/start-recording', 'POST');
      if (response.error) {
        Alert.alert('Backend Error', response.error);
        setUploadStatus('Backend error: ' + response.error);
        setIsRecording(false);
        return;
      }
      setSessionId(response.sessionId);
      setUploadStatus('Recording started');
      
      setIsRecording(true);
      
      // Start recording with 10-second segments
      startRecordingSegment();
      
      // Set up timer to create new segments every 10 seconds
      const timer = setInterval(() => {
        restartRecordingSegment();  
      }, 10000); // 10 seconds
      
      recordingTimer.current = timer;
      
    } catch (error) {
      console.error('Failed to start recording session:', error);
      Alert.alert('Error', 'Failed to start recording session');
    }
  };
  
  const startRecordingSegment = () => {
    if (!camera.current) return;
    
    camera.current.startRecording({
      fileType: 'mp4', // Ensures .mp4 output
      onRecordingFinished: async (video) => {
        console.log('Video segment saved to:', video.path);
        
        try {
          // Upload video chunk to backend
          setUploadStatus('Uploading...');
          const uploadResponse = await uploadVideoChunk(video.path);
          console.log('Video uploaded:', uploadResponse);
          setUploadStatus('Uploaded successfully');
          
          // Clean up local file after upload
          await RNFS.unlink(video.path);
          
        } catch (error) {
          console.error('Upload failed:', error);
          setUploadStatus('Upload failed');
        }
      },
      onRecordingError: (error) => {
        console.error('Recording error:', error);
        setUploadStatus('Recording error');
      },
    });
  };
  
  const restartRecordingSegment = async () => {
    if (isSegmentProcessing.current) return;

    isSegmentProcessing.current = true;
    try {
      if (camera.current) {
        await camera.current.stopRecording();
        // onRecordingFinished will handle the upload
        // A small delay helps prevent race conditions
        setTimeout(() => {
          startRecordingSegment();
        }, 250);
      }
    } catch (error) {
      console.error('Error restarting recording segment:', error);
      setUploadStatus('Error restarting');
    } finally {
      // Reset lock after a short delay to allow the next segment to start
      setTimeout(() => {
        isSegmentProcessing.current = false;
      }, 500);
    }
  };

  // Stop recording
  const handleStopRecording = async () => {
    if (!isRecording) return;

    setIsRecording(false);
    setUploadStatus('Stopping...');

    // Clear the recording timer
    if (recordingTimer.current) {
      clearInterval(recordingTimer.current);
      recordingTimer.current = null;
    }

    try {
      // Stop the camera hardware recording
      if (camera.current) {
        await camera.current.stopRecording();
      }

      // Notify the backend to stop the session
      const response = await apiCall('/stop-recording', 'POST');
      console.log('Stop recording response:', response);
      setUploadStatus('Stopped');
      setSessionId(null);

    } catch (error) {
      console.error('Failed to stop recording:', error);
      setUploadStatus('Error stopping');
      Alert.alert('Error', 'Could not stop recording. Please check backend connection.');
      setIsRecording(false);
      setUploadStatus('Error stopping recording');
    }
  };

  // If not recording, just close camera and return to main screen
  const handleCloseCamera = async () => {
    if (isRecording) {
      await handleStopRecording();
    } else {
      setShowCamera(false);
      setIsRecording(false);
      setUploadStatus('Ready');
    }
  };
  
  // Check backend health on app start
  useEffect(() => {
    const checkBackendHealth = async () => {
      try {
        const response = await apiCall('/health');
        console.log('Backend health:', response);
      } catch (error) {
        console.warn('Backend not available:', error);
        Alert.alert(
          'Backend Unavailable',
          'Please make sure the Node.js backend is running on port 3001',
          [{ text: 'OK' }]
        );
      }
    };
    
    if (!showSplash) {
      checkBackendHealth();
    }
  }, [showSplash]);

  // Splash screen
  if (showSplash) {
    return (
      <View style={styles.splashScreen}>
        <Text style={styles.splashText}>Heimdall Cam</Text>
      </View>
    );
  }

  // Main screen with animated "Open Camera" button
  if (!showCamera) {
    return (
      <View style={styles.mainScreen}>
        <Text style={styles.title}>Heimdall Cam</Text>
        <Animated.View style={{ transform: [{ scale: pulseAnim }] }}>
          <TouchableOpacity style={styles.openButton} onPress={handleOpenCamera}>
            <Text style={styles.buttonText}>Open Camera</Text>
          </TouchableOpacity>
        </Animated.View>
      </View>
    );
  }

  // Camera screen with "Record" or "Stop" button
  if (!device || !hasPermission) {
    return (
      <View style={styles.loading}>
        <Text style={{ color: 'white' }}>Loading camera...</Text>
      </View>
    );
  }

  return (
    <View style={styles.container}>
      <Camera
        ref={camera}
        style={StyleSheet.absoluteFill}
        device={device}
        isActive={true}
        video={true}
        audio={true}
      />
      <View style={styles.controls}>
        {/* Status indicator */}
        <View style={styles.statusContainer}>
          <Text style={styles.statusText}>{uploadStatus}</Text>
          {sessionId && (
            <Text style={styles.sessionText}>Session: {sessionId.substring(0, 8)}</Text>
          )}
        </View>
        
        {/* Recording controls */}
        <View style={styles.buttonContainer}>
          {!isRecording ? (
            <TouchableOpacity
              style={[styles.button, styles.recordButton]}
              onPress={handleStartRecording}
            >
              <Text style={styles.buttonText}>Record</Text>
            </TouchableOpacity>
          ) : (
            <TouchableOpacity
              style={[styles.button, styles.stopButton]}
              onPress={handleStopRecording}
            >
              <Text style={styles.buttonText}>Stop</Text>
            </TouchableOpacity>
          )}
          {!isRecording && (
            <TouchableOpacity
              style={[styles.button, styles.closeButton]}
              onPress={handleCloseCamera}
            >
              <Text style={styles.buttonText}>Close</Text>
            </TouchableOpacity>
          )}
        </View>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  splashScreen: {
    flex: 1,
    backgroundColor: '#111',
    justifyContent: 'center',
    alignItems: 'center',
  },
  splashText: {
    color: 'white',
    fontSize: 38,
    fontWeight: 'bold',
    letterSpacing: 2,
  },
  mainScreen: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    backgroundColor: 'black',
  },
  title: {
    color: 'white',
    fontSize: 32,
    fontWeight: 'bold',
    marginBottom: 40,
  },
  openButton: {
    backgroundColor: 'red',
    padding: 18,
    borderRadius: 50,
    minWidth: 180,
    alignItems: 'center',
  },
  container: { flex: 1, backgroundColor: 'black' },
  loading: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    backgroundColor: 'black',
  },
  controls: {
    position: 'absolute',
    bottom: 40,
    alignSelf: 'center',
    alignItems: 'center',
  },
  statusContainer: {
    backgroundColor: 'rgba(0, 0, 0, 0.7)',
    padding: 10,
    borderRadius: 10,
    marginBottom: 20,
    alignItems: 'center',
  },
  statusText: {
    color: 'white',
    fontSize: 14,
    fontWeight: 'bold',
  },
  sessionText: {
    color: '#ccc',
    fontSize: 12,
    marginTop: 4,
  },
  buttonContainer: {
    flexDirection: 'row',
    gap: 20,
  },
  button: {
    backgroundColor: 'red',
    padding: 18,
    borderRadius: 50,
    marginHorizontal: 10,
    minWidth: 100,
    alignItems: 'center',
  },
  recordButton: {
    backgroundColor: 'red',
  },
  stopButton: {
    backgroundColor: 'gray',
  },
  closeButton: {
    backgroundColor: '#333',
  },
  buttonText: {
    color: 'white',
    fontSize: 18,
    fontWeight: 'bold',
  },
});
