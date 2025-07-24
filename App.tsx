import React, { useRef, useState, useEffect } from 'react';
import {
  View,
  Text,
  TouchableOpacity,
  StyleSheet,
  Alert,
  AppState,
  Dimensions,
  StatusBar,
  Platform,
  PermissionsAndroid,
  Linking,
} from 'react-native';
import {
  Camera,
  useCameraDevices,
  useCameraPermission,
  useMicrophonePermission,
  getCameraDevice,
} from 'react-native-vision-camera';
import { io } from 'socket.io-client';
import DeviceInfo from 'react-native-device-info';
import RNFS from 'react-native-fs';

const { width, height } = Dimensions.get('window');
const BACKEND_URL = 'https://0cc63893afff.ngrok-free.app'; // Replace with your ngrok URL
const CHUNK_DURATION = 5 * 60 * 1000; // 5 minutes

export default function App() {
  const camera = useRef<Camera>(null);
  const [isStreaming, setIsStreaming] = useState(false);
  const [isRecording, setIsRecording] = useState(false);
  const [sessionId, setSessionId] = useState('');
  const [deviceId, setDeviceId] = useState('');
  const [socket, setSocket] = useState<any>(null);
  const [connectionStatus, setConnectionStatus] = useState('Disconnected');
  const [analysisResults, setAnalysisResults] = useState<any[]>([]);
  const [chunkCount, setChunkCount] = useState(0);
  const [isInitialized, setIsInitialized] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [permissionStatus, setPermissionStatus] = useState('checking');
  const [cameraDevice, setCameraDevice] = useState<any>(null);
  const [deviceCheckCount, setDeviceCheckCount] = useState(0);
  const [uploadStatus, setUploadStatus] = useState('');
  const [streamingStatus, setStreamingStatus] = useState('');
  const [videoStreamActive, setVideoStreamActive] = useState(false);
  const [deviceInfo, setDeviceInfo] = useState<any>(null);

  // WebRTC and streaming refs
  const frameIntervalRef = useRef<NodeJS.Timeout | null>(null);

  const { hasPermission: cameraPermission, requestPermission: requestCameraPermission } = useCameraPermission();
  const { hasPermission: microphonePermission, requestPermission: requestMicrophonePermission } = useMicrophonePermission();
  const devices = useCameraDevices();

  useEffect(() => {
    console.log('App mounted, initializing...');
    checkAndRequestPermissions();
  }, []);

  useEffect(() => {
    console.log('Camera devices updated:', devices);
    if (devices && Object.keys(devices).length > 0) {
      findCameraDevice();
    }
  }, [devices]);

  useEffect(() => {
    if (isInitialized && !cameraDevice && deviceCheckCount < 10) {
      const timer = setTimeout(() => {
        console.log(`Retrying camera device detection... Attempt ${deviceCheckCount + 1}`);
        setDeviceCheckCount(prev => prev + 1);
        findCameraDevice();
      }, 1000);
      return () => clearTimeout(timer);
    }
  }, [isInitialized, cameraDevice, deviceCheckCount]);

  const getAllDeviceInfo = () => {
    if (!devices || Object.keys(devices).length === 0) {
      console.log('❌ No camera devices available');
      return [];
    }

    const deviceInfo: any[] = [];
    
    Object.entries(devices).forEach(([key, device]) => {
      if (!device) return;
      
      const info = {
        key: key,
        id: device.id,
        name: device.name || `Camera ${device.id}`,
        position: device.position,
        hasFlash: device.hasFlash,
        hasTorch: device.hasTorch,
        supportsLowLightBoost: device.supportsLowLightBoost,
        supportsFocus: device.supportsFocus,
        supportsRawCapture: device.supportsRawCapture,
        isMultiCam: device.isMultiCam,
        hardwareLevel: device.hardwareLevel,
        sensorOrientation: device.sensorOrientation,
        minZoom: device.minZoom,
        maxZoom: device.maxZoom,
        neutralZoom: device.neutralZoom,
        minFocusDistance: device.minFocusDistance,
        minExposure: device.minExposure,
        maxExposure: device.maxExposure,
        physicalDevices: device.physicalDevices || [],
        formatCount: device.formats?.length || 0,
        bestVideoFormats: device.formats
          ?.filter(f => f.videoWidth && f.videoHeight)
          ?.sort((a, b) => (b.videoWidth * b.videoHeight) - (a.videoWidth * a.videoHeight))
          ?.slice(0, 3)
          ?.map(f => ({
            resolution: `${f.videoWidth}x${f.videoHeight}`,
            fps: `${f.minFps}-${f.maxFps}`,
            photoRes: `${f.photoWidth}x${f.photoHeight}`,
            autoFocus: f.autoFocusSystem,
            hdr: f.supportsVideoHdr,
            stabilization: f.videoStabilizationModes?.join(', '),
            fieldOfView: f.fieldOfView?.toFixed(1),
            isoRange: `${f.minISO}-${f.maxISO}`,
          })) || [],
      };
      
      deviceInfo.push(info);
    });
    
    return deviceInfo;
  };

  const findCameraDevice = () => {
    try {
      console.log('🔍 Finding camera device...');
      const allDevices = getAllDeviceInfo();
      console.log('📱 Available camera devices:');
      allDevices.forEach((device: any, index: number) => {
        console.log(`\n📷 Device ${index + 1}:`);
        console.log(`  ID: ${device.id}`);
        console.log(`  Name: ${device.name}`);
        console.log(`  Position: ${device.position}`);
        console.log(`  Flash: ${device.hasFlash ? '✅' : '❌'}`);
        console.log(`  Torch: ${device.hasTorch ? '✅' : '❌'}`);
        console.log(`  Focus: ${device.supportsFocus ? '✅' : '❌'}`);
        console.log(`  Hardware Level: ${device.hardwareLevel}`);
        console.log(`  Zoom Range: ${device.minZoom}x - ${device.maxZoom}x`);
        console.log(`  Total Formats: ${device.formatCount}`);
      });

      let device: any = null;
      let selectedDeviceInfo: any = null;

      // devices is an array, so use array methods
      if (Array.isArray(devices)) {
        device = devices.find((d: any) => d.position === 'back') || devices[0];
        selectedDeviceInfo = allDevices.find((d: any) => d.position === (device ? device.position : 'back')) || allDevices[0];
      } else if (devices) {
        // fallback for object (shouldn't happen)
        const deviceArr = Object.values(devices);
        device = deviceArr.find((d: any) => d.position === 'back') || deviceArr[0];
        selectedDeviceInfo = allDevices.find((d: any) => d.position === (device ? device.position : 'back')) || allDevices[0];
      }

      if (device && selectedDeviceInfo) {
        console.log('\n🎯 Final Camera Selection:');
        console.log(`   Device ID: ${selectedDeviceInfo.id}`);
        console.log(`   Name: ${selectedDeviceInfo.name}`);
        console.log(`   Position: ${selectedDeviceInfo.position}`);
        console.log(`   Available Formats: ${selectedDeviceInfo.formatCount}`);
        setCameraDevice(device);
        setDeviceInfo(selectedDeviceInfo);
      } else {
        console.log('\n❌ No suitable camera device found');
        if (deviceCheckCount >= 9) {
          setError('No camera device available. Please check if your device has a working camera.');
        }
      }
    } catch (error) {
      if (error instanceof Error) {
        console.error('❌ Error finding camera device:', error.message);
        setError(`Camera detection error: ${error.message}`);
      } else {
        console.error('❌ Error finding camera device:', error);
        setError('Camera detection error');
      }
    }
  };

  const checkAndRequestPermissions = async () => {
    try {
      setPermissionStatus('checking');
      console.log('Checking permissions...');

      const cameraStatus = await PermissionsAndroid.check(PermissionsAndroid.PERMISSIONS.CAMERA);
      const audioStatus = await PermissionsAndroid.check(PermissionsAndroid.PERMISSIONS.RECORD_AUDIO);
      
      console.log('Current permissions - Camera:', cameraStatus, 'Audio:', audioStatus);

      if (cameraStatus && audioStatus) {
        console.log('All permissions already granted');
        await initializeApp();
        return;
      }

      if (!cameraStatus) {
        console.log('Requesting camera permission...');
        const cameraResult = await PermissionsAndroid.request(
          PermissionsAndroid.PERMISSIONS.CAMERA,
          {
            title: 'Heimdall Camera Permission',
            message: 'Heimdall needs access to your camera for security monitoring',
            buttonNeutral: 'Ask Me Later',
            buttonNegative: 'Cancel',
            buttonPositive: 'OK',
          }
        );
        
        if (cameraResult !== PermissionsAndroid.RESULTS.GRANTED) {
          setError('Camera permission is required for the app to work');
          setPermissionStatus('denied');
          return;
        }
      }

      if (!audioStatus) {
        console.log('Requesting audio permission...');
        const audioResult = await PermissionsAndroid.request(
          PermissionsAndroid.PERMISSIONS.RECORD_AUDIO,
          {
            title: 'Heimdall Microphone Permission',
            message: 'Heimdall needs access to your microphone for audio recording',
            buttonNeutral: 'Ask Me Later',
            buttonNegative: 'Cancel',
            buttonPositive: 'OK',
          }
        );
        
        if (audioResult !== PermissionsAndroid.RESULTS.GRANTED) {
          setError('Microphone permission is required for audio recording');
          setPermissionStatus('denied');
          return;
        }
      }

      console.log('All permissions granted, initializing app...');
      await initializeApp();

    } catch (error) {
      console.error('Permission request error:', error);
      setError(`Permission error: ${error}`);
      setPermissionStatus('error');
    }
  };

  const initializeApp = async () => {
    try {
      console.log('Initializing app...');
      setPermissionStatus('granted');
      
      if (!cameraPermission) {
        console.log('Requesting Vision Camera permission...');
        const visionCameraResult = await requestCameraPermission();
        if (!visionCameraResult) {
          setError('Vision Camera permission denied');
          return;
        }
      }

      if (!microphonePermission) {
        console.log('Requesting Vision Camera microphone permission...');
        const visionMicResult = await requestMicrophonePermission();
        if (!visionMicResult) {
          setError('Vision Camera microphone permission denied');
          return;
        }
      }

      console.log('Getting device ID...');
      const id = await DeviceInfo.getUniqueId();
      setDeviceId(id);
      
      const newSessionId = `${id}-${Date.now()}`;
      setSessionId(newSessionId);
      
      setIsInitialized(true);
      setError(null);
      console.log('App initialized successfully');

      findCameraDevice();
      
    } catch (error) {
      console.error('Initialization error:', error);
      setError(`Initialization failed: ${error}`);
    }
  };

  const testBackendConnection = async () => {
    try {
      console.log('🔍 Testing backend connection...');
      const controller = new AbortController();
      const timeoutId = setTimeout(() => {
        controller.abort();
        console.log('⏰ Backend connection test timeout');
      }, 8000);
      const response = await fetch(`${BACKEND_URL}/health`, {
        method: 'GET',
        headers: {
          'ngrok-skip-browser-warning': 'true',
          'Content-Type': 'application/json',
          'Accept': 'application/json',
        },
        signal: controller.signal,
      });
      clearTimeout(timeoutId);
      if (response.ok) {
        const data = await response.json();
        console.log('✅ Backend is reachable:', data);
        return true;
      } else {
        console.log('❌ Backend responded with error:', response.status, await response.text());
        return false;
      }
    } catch (error) {
      if (error instanceof Error && error.name === 'AbortError') {
        console.error('❌ Backend connection test timeout');
      } else {
        console.error('❌ Backend connection test failed:', error);
      }
      return false;
    }
  };

  const connectToServer = async () => {
    try {
      console.log('Testing backend connection first...');
      const isBackendReachable = await testBackendConnection();
      
      if (!isBackendReachable) {
        throw new Error('Backend server not reachable');
      }

      console.log('Creating socket connection to:', BACKEND_URL);
      
      const newSocket = io(BACKEND_URL, {
        transports: ['websocket'],
        timeout: 15000,
        reconnection: true,
        reconnectionDelay: 2000,
        reconnectionAttempts: 5,
        forceNew: true,
        extraHeaders: {
          'ngrok-skip-browser-warning': 'true'
        }
      });

      return new Promise((resolve, reject) => {
        const connectionTimeout = setTimeout(() => {
          console.error('Socket connection timeout after 15 seconds');
          newSocket.disconnect();
          reject(new Error('Connection timeout'));
        }, 15000);

        newSocket.on('connect', () => {
          clearTimeout(connectionTimeout);
          console.log('✅ Socket connected successfully');
          setConnectionStatus('Connected');
          newSocket.emit('register-device', { deviceId, sessionId });
          resolve(newSocket);
        });

        newSocket.on('connect_error', (error) => {
          clearTimeout(connectionTimeout);
          console.error('❌ Socket connection failed:', error);
          newSocket.disconnect();
          reject(error);
        });

        newSocket.on('disconnect', (reason) => {
          console.log('Socket disconnected:', reason);
          setConnectionStatus('Disconnected');
        });

        newSocket.on('analysis-result', (data) => {
          console.log('Received analysis result:', data);
          setAnalysisResults(prev => [...prev, data]);
        });

        newSocket.on('error', (error) => {
          console.error('Socket error:', error);
        });
      });

    } catch (error) {
      console.error('Connection setup failed:', error);
      setConnectionStatus('Connection Failed');
      throw error;
    }
  };

  const startVideoStreaming = async (socketConnection: any) => {
    try {
      console.log('🎥 Starting WebRTC video streaming...');
      setStreamingStatus('Initializing video stream...');
      if (!camera.current) {
        throw new Error('Camera not available');
      }
      setVideoStreamActive(true);
      setStreamingStatus('Video stream active');
      startSmoothFrameStreaming(socketConnection);
      console.log('✅ WebRTC video streaming started');
    } catch (error: any) {
      if (error instanceof Error) {
        console.error('❌ Video streaming setup failed:', error.message);
        setStreamingStatus('Video streaming failed');
        throw error;
      } else {
        console.error('❌ Video streaming setup failed:', error);
        setStreamingStatus('Video streaming failed');
        throw new Error('Video streaming failed');
      }
    }
  };

  const startSmoothFrameStreaming = (socketConnection: any) => {
    console.log('🎬 Starting smooth frame streaming...');
    let frameCount = 0;
    frameIntervalRef.current = setInterval(async () => {
      try {
        if (!camera.current || !(socketConnection && socketConnection.connected) || !videoStreamActive) {
          if (!camera.current) {
            console.log('Camera ref is null in frame streaming!');
          }
          if (!(socketConnection && socketConnection.connected)) {
            console.log('Socket not connected in frame streaming!');
          }
          if (!videoStreamActive) {
            console.log('Video stream not active in frame streaming!');
          }
          return;
        }
        let photo;
        try {
          photo = await camera.current.takePhoto({ flash: 'off' });
        } catch (err) {
          console.error('Error taking photo for streaming:', err);
          return;
        }
        frameCount++;
        const frameData = await convertImageToBase64Fast(photo.path);
        if (frameData) {
          console.log('Emitting live-video-frame', { deviceId, frameNumber: frameCount, frameData: frameData.substring(0, 30) });
          socketConnection.emit('live-video-frame', {
            deviceId,
            sessionId,
            frame: frameData,
            timestamp: Date.now(),
            frameNumber: frameCount,
            streamType: 'live',
            fps: 10,
          });
          if (frameCount % 30 === 0) {
            console.log(`📹 Streaming frame ${frameCount} (10 FPS)`);
            setStreamingStatus(`Live streaming: ${frameCount} frames`);
          }
        }
      } catch (error: any) {
        if (error && error.code === 'capture/photo-not-enabled') {
          console.error('❌ Photo capture not enabled for streaming');
          stopVideoStreaming();
        } else {
          console.error('❌ Frame streaming error:', error);
        }
      }
    }, 100); // 100ms = 10 FPS
  };

  const convertImageToBase64Fast = async (imagePath: string) => {
    try {
      const fileUri = imagePath.startsWith('file://') ? imagePath : `file://${imagePath}`;
      const base64Data = await RNFS.readFile(fileUri, 'base64');
      return `data:image/jpeg;base64,${base64Data}`;
    } catch (error) {
      console.error('Base64 conversion error:', error);
      return null;
    }
  };

  const startStreaming = async () => {
    try {
      if (!cameraDevice) {
        Alert.alert('Camera Error', 'Camera device not available. Please restart the app.');
        return;
      }

      setIsStreaming(true);
      setConnectionStatus('Connecting...');
      setError(null);
      
      console.log('🚀 Starting enhanced video streaming...');

      let connectedSocket: any;
      try {
        connectedSocket = await connectToServer();
        setSocket(connectedSocket);
        console.log('✅ Socket connection established');
        connectedSocket.emit('start-stream', { deviceId, sessionId });
      } catch (connectionError: any) {
        console.error('❌ Failed to connect to server:', connectionError);
        setIsStreaming(false);
        setConnectionStatus('Connection Failed');
        Alert.alert('Connection Failed', `Unable to connect to server: ${connectionError.message}`);
        return;
      }

      if (!connectedSocket || !connectedSocket.connected) {
        console.error('❌ Socket not properly connected');
        setIsStreaming(false);
        setConnectionStatus('Connection Failed');
        return;
      }

      await new Promise(resolve => setTimeout(resolve, 1000));

      setConnectionStatus('Starting Video Stream...');

      await startVideoStreaming(connectedSocket);
      await startChunkedRecording();

      setConnectionStatus('Live Streaming');
      console.log('✅ Enhanced streaming started successfully');

    } catch (error: any) {
      console.error('❌ Start streaming error:', error);
      setIsStreaming(false);
      setConnectionStatus('Connection Failed');
      setError(`Failed to start streaming: ${error.message}`);
    }
  };

  const startChunkedRecording = async () => {
    try {
      console.log('Starting chunked recording...');
      setIsRecording(true);
      
      if (!camera.current) {
        throw new Error('Camera reference not available');
      }

      await camera.current.startRecording({
        flash: 'off',
        onRecordingFinished: (video) => {
          console.log('Recording finished:', video);
          uploadVideoChunk(video);
        },
        onRecordingError: (error) => {
          console.error('Recording error:', error);
          Alert.alert('Recording Error', error.message);
        },
      });

      setTimeout(() => {
        if (isRecording && camera.current) {
          camera.current.stopRecording();
          if (isStreaming) {
            setChunkCount(prev => prev + 1);
            startChunkedRecording();
          }
        }
      }, CHUNK_DURATION);

    } catch (error: any) {
      console.error('Start recording error:', error);
      setError(`Recording failed: ${error.message}`);
    }
  };

  const uploadVideoChunk = async (video: { path: string; duration?: number; [key: string]: any }) => {
    const chunkId = `${sessionId}-chunk-${chunkCount}`;
    setUploadStatus(`Uploading chunk ${chunkCount}...`);
    
    if (!video || !video.path) {
      console.error('❌ Invalid video object:', video);
      setUploadStatus('Upload failed: Invalid video file');
      return;
    }

    const formData = new FormData();
    formData.append('video', {
      uri: video.path,
      type: 'video/mp4',
      name: `${chunkId}.mp4`,
    } as any);
    formData.append('sessionId', sessionId);
    formData.append('deviceId', deviceId);
    formData.append('chunkId', chunkId);

    let retryCount = 0;
    const maxRetries = 3;

    while (retryCount < maxRetries) {
      try {
        console.log(`📤 Upload attempt ${retryCount + 1}/${maxRetries} for chunk ${chunkCount}`);
        
        const isBackendReachable = await testBackendConnection();
        if (!isBackendReachable) {
          throw new Error('Backend server not reachable');
        }

        const controller = new AbortController();
        const timeoutId = setTimeout(() => {
          controller.abort();
          console.log('⏰ Upload timeout after 90 seconds');
        }, 90000);

        const response = await fetch(`${BACKEND_URL}/upload-chunk`, {
          method: 'POST',
          body: formData,
          headers: {
            'ngrok-skip-browser-warning': 'true',
          },
          signal: controller.signal,
        });

        clearTimeout(timeoutId);

        if (response.ok) {
          const result = await response.json();
          console.log(`✅ Chunk ${chunkCount} uploaded successfully:`, result);
          setUploadStatus(`✅ Chunk ${chunkCount} uploaded successfully`);
          
          if (socket && socket.connected) {
            socket.emit('chunk-uploaded', { chunkId, sessionId, deviceId });
          }
          
          setTimeout(() => setUploadStatus(''), 3000);
          return;
          
        } else {
          const errorText = await response.text();
          console.error(`❌ Upload failed with status: ${response.status}`);
          console.error('❌ Error response:', errorText);
          
          if (response.status >= 500) {
            throw new Error(`Server error: ${response.status} - ${errorText}`);
          } else {
            setUploadStatus(`❌ Upload failed: ${response.status}`);
            return;
          }
        }
        
      } catch (error: any) {
        console.error(`❌ Upload error (Attempt ${retryCount + 1}):`, error);
        retryCount++;
        
        let errorMessage = 'Unknown error';
        
        if (error.name === 'AbortError') {
          errorMessage = 'Request timeout';
          setUploadStatus('❌ Upload timeout');
        } else if (error.message && error.message.includes('Network request failed')) {
          errorMessage = 'Network connectivity issue';
          setUploadStatus(`❌ Network error (${retryCount}/${maxRetries})`);
        } else if (error.message && error.message.includes('not reachable')) {
          errorMessage = 'Backend server not accessible';
          setUploadStatus(`❌ Server unreachable (${retryCount}/${maxRetries})`);
        } else {
          errorMessage = error.message;
          setUploadStatus(`❌ Upload error: ${error.message}`);
        }
        
        console.log(`🔄 Will retry in ${Math.pow(2, retryCount)}s due to: ${errorMessage}`);
        
        if (retryCount < maxRetries) {
          const delay = Math.pow(2, retryCount) * 1000;
          await new Promise(resolve => setTimeout(resolve, delay));
        }
      }
    }
    
    setUploadStatus(`❌ Upload failed after ${maxRetries} attempts`);
    
    Alert.alert(
      'Upload Failed',
      `Failed to upload video chunk after ${maxRetries} attempts.\n\nDiagnostic steps:\n1. Check internet connection\n2. Verify ngrok tunnel is active\n3. Check backend server logs\n4. Try restarting the app`,
      [
        { text: 'Retry Now', onPress: () => uploadVideoChunk(video) },
        { text: 'Skip', style: 'cancel' }
      ]
    );
  };

  const stopVideoStreaming = async () => {
    try {
      console.log('🛑 Stopping video streaming...');
      
      setVideoStreamActive(false);
      setStreamingStatus('');

      if (frameIntervalRef.current) {
        clearInterval(frameIntervalRef.current);
        frameIntervalRef.current = null;
      }

      if (camera.current) {
        try {
          await camera.current.stopRecording();
          console.log('✅ Camera recording stopped');
        } catch (error) {
          console.error('❌ Error stopping camera:', error);
        }
      }

      console.log('✅ Video streaming stopped successfully');

    } catch (error) {
      console.error('❌ Stop video streaming error:', error);
    }
  };

  const stopStreaming = async () => {
    try {
      console.log('🛑 Stopping all streaming...');
      
      setIsStreaming(false);
      setIsRecording(false);
      setConnectionStatus('Disconnecting...');
      setUploadStatus('');

      await stopVideoStreaming();

      if (socket) {
        try {
          if (socket.connected) {
            socket.emit('stop-stream', { deviceId, sessionId });
          }
          socket.disconnect();
          setSocket(null);
          console.log('✅ Socket disconnected');
        } catch (error) {
          console.error('❌ Error disconnecting socket:', error);
        }
      }

      const newSessionId = `${deviceId}-${Date.now()}`;
      setSessionId(newSessionId);
      setChunkCount(0);
      setAnalysisResults([]);
      setConnectionStatus('Disconnected');

      console.log('✅ All streaming stopped successfully');

    } catch (error) {
      console.error('❌ Stop streaming error:', error);
      setConnectionStatus('Disconnected');
    }
  };

  const getLatestAnalysis = () => {
    if (analysisResults.length === 0) return 'No analysis available';
    
    const latest = analysisResults[analysisResults.length - 1];
    const labels = latest.labels?.slice(0, 3).map((l: any) => l.description).join(', ') || 'No objects detected';
    const peopleCount = latest.personDetection?.detectedPersons?.length || 0;
    
    return `Objects: ${labels} | People: ${peopleCount}`;
  };

  const openAppSettings = () => {
    Alert.alert(
      'Permission Required',
      'Please grant camera and microphone permissions in app settings to use Heimdall.',
      [
        { text: 'Cancel', style: 'cancel' },
        { text: 'Open Settings', onPress: () => Linking.openSettings() }
      ]
    );
  };

  // Error screen
  if (error) {
    return (
      <View style={styles.errorContainer}>
        <Text style={styles.brandText}>HEIMDALL</Text>
        <Text style={styles.errorTitle}>⚠️ Error</Text>
        <Text style={styles.errorText}>{error}</Text>
        <View style={styles.buttonContainer}>
          <TouchableOpacity style={styles.button} onPress={() => {
            setError(null);
            setPermissionStatus('checking');
            setDeviceCheckCount(0);
            setCameraDevice(null);
            setConnectionStatus('Disconnected');
            checkAndRequestPermissions();
          }}>
            <Text style={styles.buttonText}>Retry</Text>
          </TouchableOpacity>
          {error.includes('permission') && (
            <TouchableOpacity style={[styles.button, styles.secondaryButton]} onPress={openAppSettings}>
              <Text style={styles.buttonText}>Open Settings</Text>
            </TouchableOpacity>
          )}
        </View>
      </View>
    );
  }

  // Permission screens
  if (permissionStatus === 'checking') {
    return (
      <View style={styles.permissionContainer}>
        <Text style={styles.brandText}>HEIMDALL</Text>
        <Text style={styles.subtitle}>Security Monitoring</Text>
        <Text style={styles.permissionText}>Checking permissions...</Text>
      </View>
    );
  }

  if (permissionStatus === 'denied') {
    return (
      <View style={styles.permissionContainer}>
        <Text style={styles.brandText}>HEIMDALL</Text>
        <Text style={styles.subtitle}>Security Monitoring</Text>
        <Text style={styles.permissionText}>Camera and microphone permissions are required for security monitoring.</Text>
        <View style={styles.buttonContainer}>
          <TouchableOpacity style={styles.button} onPress={checkAndRequestPermissions}>
            <Text style={styles.buttonText}>Grant Permissions</Text>
          </TouchableOpacity>
          <TouchableOpacity style={[styles.button, styles.secondaryButton]} onPress={openAppSettings}>
            <Text style={styles.buttonText}>Open Settings</Text>
          </TouchableOpacity>
        </View>
      </View>
    );
  }

  // Loading screen
  if (!isInitialized || !cameraDevice) {
    return (
      <View style={styles.loadingContainer}>
        <Text style={styles.brandText}>HEIMDALL</Text>
        <Text style={styles.loadingText}>
          {!isInitialized ? 'Initializing...' : `Loading Camera... (${deviceCheckCount}/10)`}
        </Text>
        {deviceCheckCount > 5 && (
          <TouchableOpacity style={styles.button} onPress={() => {
            setDeviceCheckCount(0);
            setCameraDevice(null);
            findCameraDevice();
          }}>
            <Text style={styles.buttonText}>Retry Camera Detection</Text>
          </TouchableOpacity>
        )}
      </View>
    );
  }

  // Main app interface
  return (
    <View style={styles.container}>
      <StatusBar backgroundColor="#000" barStyle="light-content" />
      
      <View style={styles.header}>
        <Text style={styles.brandText}>HEIMDALL</Text>
        <Text style={styles.subtitle}>Live Video Streaming</Text>
      </View>

      <Camera
        ref={camera}
        style={styles.camera}
        device={cameraDevice}
        isActive={true}
        video={true}
        audio={true}
        photo={true}
      />

      <View style={styles.statusOverlay}>
        <View style={[
          styles.statusDot, 
          { backgroundColor: videoStreamActive ? '#00ff00' : socket?.connected ? '#ffff00' : '#ff0000' }
        ]} />
        <Text style={styles.statusText}>{connectionStatus}</Text>
      </View>

      {streamingStatus ? (
        <View style={styles.streamingStatusContainer}>
          <Text style={styles.streamingStatusText}>📹 {streamingStatus}</Text>
        </View>
      ) : null}

      {uploadStatus ? (
        <View style={styles.uploadStatusContainer}>
          <Text style={styles.uploadStatusText}>{uploadStatus}</Text>
        </View>
      ) : null}

      {analysisResults.length > 0 && (
        <View style={styles.analysisContainer}>
          <Text style={styles.analysisTitle}>Live Analysis:</Text>
          <Text style={styles.analysisText}>{getLatestAnalysis()}</Text>
        </View>
      )}

      <View style={styles.controls}>
        <View style={styles.sessionInfo}>
          <Text style={styles.sessionText}>Device: {deviceId.substring(0, 8)}...</Text>
          <Text style={styles.sessionText}>Video Chunks: {chunkCount}</Text>
          <Text style={styles.sessionText}>Status: {connectionStatus}</Text>
          {deviceInfo && (
            <>
              <Text style={styles.sessionText}>Camera: {deviceInfo.name}</Text>
              <Text style={styles.sessionText}>Position: {deviceInfo.position}</Text>
              <Text style={styles.sessionText}>
                Features: {deviceInfo.hasFlash ? '📸' : ''}{deviceInfo.hasTorch ? '🔦' : ''}{deviceInfo.supportsFocus ? '🎯' : ''}
              </Text>
            </>
          )}
          {videoStreamActive && (
            <Text style={styles.sessionText}>🔴 LIVE STREAMING</Text>
          )}
        </View>

        <TouchableOpacity
          style={[styles.recordButton, isStreaming && styles.recordButtonActive]}
          onPress={isStreaming ? stopStreaming : startStreaming}
          disabled={connectionStatus === 'Connecting...' || connectionStatus === 'Starting Video Stream...'}
        >
          <Text style={styles.recordButtonText}>
            {isStreaming ? 'STOP LIVE STREAM' : 
             connectionStatus === 'Connecting...' ? 'CONNECTING...' : 
             connectionStatus === 'Starting Video Stream...' ? 'STARTING...' : 
             'START LIVE STREAM'}
          </Text>
        </TouchableOpacity>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#000',
  },
  header: {
    position: 'absolute',
    top: 50,
    left: 20,
    zIndex: 10,
  },
  brandText: {
    color: '#ff6b35',
    fontSize: 28,
    fontWeight: '900',
    letterSpacing: 3,
    textShadowColor: '#000',
    textShadowOffset: { width: 2, height: 2 },
    textShadowRadius: 4,
  },
  subtitle: {
    color: '#fff',
    fontSize: 12,
    letterSpacing: 1,
    marginTop: 2,
  },
  camera: {
    flex: 1,
  },
  statusOverlay: {
    position: 'absolute',
    top: 50,
    right: 20,
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: 'rgba(0,0,0,0.7)',
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 20,
  },
  statusDot: {
    width: 10,
    height: 10,
    borderRadius: 5,
    marginRight: 8,
  },
  statusText: {
    color: '#fff',
    fontSize: 12,
    fontWeight: 'bold',
  },
  streamingStatusContainer: {
    position: 'absolute',
    top: 90,
    left: 20,
    backgroundColor: 'rgba(255,0,0,0.8)',
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 15,
    maxWidth: 250,
  },
  streamingStatusText: {
    color: '#ffffff',
    fontSize: 11,
    fontWeight: 'bold',
  },
  uploadStatusContainer: {
    position: 'absolute',
    top: 90,
    right: 20,
    backgroundColor: 'rgba(0,0,0,0.7)',
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 15,
    maxWidth: 200,
  },
  uploadStatusText: {
    color: '#00ff00',
    fontSize: 10,
    fontWeight: 'bold',
  },
  analysisContainer: {
    position: 'absolute',
    top: 120,
    left: 20,
    right: 20,
    backgroundColor: 'rgba(0,0,0,0.8)',
    padding: 12,
    borderRadius: 8,
  },
  analysisTitle: {
    color: '#ff6b35',
    fontSize: 14,
    fontWeight: 'bold',
    marginBottom: 4,
  },
  analysisText: {
    color: '#fff',
    fontSize: 12,
  },
  controls: {
    position: 'absolute',
    bottom: 50,
    left: 20,
    right: 20,
    alignItems: 'center',
  },
  sessionInfo: {
    backgroundColor: 'rgba(0,0,0,0.7)',
    padding: 8,
    borderRadius: 8,
    marginBottom: 20,
    alignItems: 'center',
  },
  sessionText: {
    color: '#ccc',
    fontSize: 10,
  },
  recordButton: {
    backgroundColor: '#ff6b35',
    paddingVertical: 15,
    paddingHorizontal: 40,
    borderRadius: 30,
    elevation: 5,
  },
  recordButtonActive: {
    backgroundColor: '#ff3333',
  },
  recordButtonText: {
    color: '#fff',
    fontSize: 16,
    fontWeight: 'bold',
    letterSpacing: 1,
  },
  permissionContainer: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    backgroundColor: '#000',
    padding: 20,
  },
  permissionText: {
    color: '#fff',
    fontSize: 16,
    marginBottom: 30,
    textAlign: 'center',
    lineHeight: 24,
  },
  buttonContainer: {
    flexDirection: 'column',
    gap: 15,
  },
  button: {
    backgroundColor: '#ff6b35',
    paddingVertical: 12,
    paddingHorizontal: 24,
    borderRadius: 8,
    minWidth: 200,
    alignItems: 'center',
    marginTop: 20,
  },
  secondaryButton: {
    backgroundColor: '#666',
  },
  buttonText: {
    color: '#fff',
    fontSize: 16,
    fontWeight: 'bold',
  },
  loadingContainer: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    backgroundColor: '#000',
  },
  loadingText: {
    color: '#ff6b35',
    fontSize: 20,
    fontWeight: 'bold',
    marginTop: 20,
    textAlign: 'center',
  },
  errorContainer: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    backgroundColor: '#000',
    padding: 20,
  },
  errorTitle: {
    color: '#ff0000',
    fontSize: 24,
    fontWeight: 'bold',
    marginBottom: 20,
    marginTop: 20,
  },
  errorText: {
    color: '#fff',
    fontSize: 16,
    textAlign: 'center',
    marginBottom: 30,
    lineHeight: 24,
  },
});