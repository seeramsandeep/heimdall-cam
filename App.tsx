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
  Dimensions,
  NativeModules,
  NativeEventEmitter,
  StatusBar,
  SafeAreaView,
  ScrollView,
} from 'react-native';
import {
  Camera,
  useCameraDevices,
  CameraPermissionStatus,
} from 'react-native-vision-camera';
import type { Camera as CameraType } from 'react-native-vision-camera';
import RNFS from 'react-native-fs';
import 'react-native-get-random-values';
import uuid from 'react-native-uuid';

// Backend API configuration
const BACKEND_URL = 'https://74ceb071ec36.ngrok-free.app';

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

// Types for metadata
interface RecordingMetadata {
  deviceId: string;
  timestamp: string;
  location?: {
    latitude: number;
    longitude: number;
    accuracy: number;
  };
  deviceInfo: {
    brand: string;
    model: string;
    os: string;
    osVersion: string;
  };
  cameraInfo: {
    id: string;
    position: string;
    resolution: {
      width: number;
      height: number;
    };
  };
  viewport: {
    width: number;
    height: number;
    scale: number;
    fontScale: number;
  };
  orientation: 'portrait' | 'landscape';
  gyro?: {
    x: number;
    y: number;
    z: number;
  };
  recordingSettings: {
    codec: string;
    quality: string;
    bitrate: number;
  };
}

export default function App() {
  const camera = useRef<CameraType>(null);
  const currentChunkIndex = useRef(0);
  const [hasPermission, setHasPermission] = useState(false);
  const [showCamera, setShowCamera] = useState(false);
  const [showSplash, setShowSplash] = useState(true);
  const [isRecording, setIsRecording] = useState(false);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [uploadStatus, setUploadStatus] = useState<string>('Ready');
  const [deviceOrientation, setDeviceOrientation] = useState<'portrait' | 'landscape'>(
    Dimensions.get('window').width > Dimensions.get('window').height ? 'landscape' : 'portrait'
  );
  const [location, setLocation] = useState<{latitude: number, longitude: number, accuracy: number} | null>(null);
  const [gyroData, setGyroData] = useState<{x: number, y: number, z: number} | null>(null);
  
  // Generate persistent deviceId for this session
  const [deviceId] = useState<string>(() => uuid.v4().toString());
  
  // Animation values
  const pulseAnim = useRef(new Animated.Value(1)).current;
  const fadeAnim = useRef(new Animated.Value(0)).current;
  const slideAnim = useRef(new Animated.Value(50)).current;
  const recordPulseAnim = useRef(new Animated.Value(1)).current;
  const statusFadeAnim = useRef(new Animated.Value(0)).current;
  
  const recordingTimer = useRef<NodeJS.Timeout | null>(null);
  const isSegmentProcessing = useRef(false);
  const gyroSubscription = useRef<{remove: () => void} | null>(null);
  const locationSubscription = useRef<{remove: () => void} | null>(null);

  const devices = useCameraDevices();
  const device = devices.find(device => device.position === 'back');

  // Select optimal format for lower memory usage and framerate
  const getOptimalFormat = () => {
    if (!device || !device.formats) return null;
    
    const optimalFormats = device.formats.filter(format => {
      const resolution = format.videoWidth * format.videoHeight;
      const hasLowFramerate = format.maxFps <= 30;
      return resolution <= (1280 * 720) && hasLowFramerate;
    });
    
    return optimalFormats.sort((a, b) => {
      const aResolution = a.videoWidth * a.videoHeight;
      const bResolution = b.videoWidth * b.videoHeight;
      return aResolution - bResolution;
    })[0] || device.formats[0];
  };

  const selectedFormat = getOptimalFormat();

  // Log device info for debugging
  useEffect(() => {
    console.log('🔧 Heimdall Cam - Session Configuration:');
    console.log(`  Device ID: ${deviceId}`);
    console.log(`  Optimized for: Low memory usage, 10-second segments`);
    console.log(`  Video Quality: 720p max, 30fps max, 2Mbps bitrate`);
    console.log(`  File Organization: devices/${deviceId}/sessions/${sessionId}/chunks/`);
  }, [deviceId]);

  // Log the selected format for debugging
  useEffect(() => {
    if (selectedFormat) {
      console.log('📹 Camera optimized for low memory usage:');
      console.log(`  Resolution: ${selectedFormat.videoWidth}x${selectedFormat.videoHeight}`);
      console.log(`  Max FPS: ${selectedFormat.maxFps}`);
      console.log(`  Video Stabilization: ${selectedFormat.videoStabilizationModes?.length > 0 ? 'Available' : 'Not available'}`);
    }
  }, [selectedFormat]);

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

  const uploadVideoChunk = async (videoPath: string, metadata: RecordingMetadata) => {
    try {
      const ext = videoPath.split('.').pop() || 'mov';
      const mimeType = getMimeType(ext);
      const timestamp = new Date().toISOString();
      const chunkIndex = currentChunkIndex.current;

      const formData = new FormData();
      
      formData.append('video', {
        uri: Platform.OS === 'android' ? 'file://' + videoPath : videoPath,
        type: mimeType,
        name: `video_${Date.now()}.${ext}`,
      } as any);
      
      const metadataBlob = new Blob(
        [JSON.stringify({
          ...metadata,
          chunkTimestamp: timestamp,
          chunkIndex: chunkIndex,
        })],
        { 
          type: 'application/json',
          // @ts-ignore - BlobOptions type is not fully compatible with React Native
          lastModified: Date.now()
        }
      );
      
      formData.append('metadata', {
        uri: `data:application/json;base64,${await blobToBase64(metadataBlob)}`,
        type: 'application/json',
        name: 'metadata.json',
      } as any);

      console.log(`Uploading chunk ${chunkIndex} with metadata:`, 
        JSON.stringify(metadata, null, 2));
        
      const response = await fetch(`${BACKEND_URL}/upload-chunk`, {
        method: 'POST',
        body: formData,
        headers: {
          'Content-Type': 'multipart/form-data',
        },
      });

      const result = await response.json();
      console.log(`Chunk ${chunkIndex} upload response:`, result);
      
      currentChunkIndex.current += 1;
      
      return result;
      } catch (error) {
      console.error('Video upload failed:', error);
      throw error;
    }
  };

  // Helper function to convert Blob to base64
  const blobToBase64 = (blob: Blob): Promise<string> => {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => {
        const base64String = (reader.result as string).split(',')[1];
        resolve(base64String);
      };
      reader.onerror = reject;
      reader.readAsDataURL(blob);
    });
  };

  // Enhanced splash screen with animations
  useEffect(() => {
    const timer = setTimeout(() => {
      Animated.parallel([
        Animated.timing(fadeAnim, {
          toValue: 0,
          duration: 800,
          useNativeDriver: true,
          easing: Easing.out(Easing.cubic),
        }),
        Animated.timing(slideAnim, {
          toValue: -100,
          duration: 800,
          useNativeDriver: true,
          easing: Easing.out(Easing.cubic),
        }),
      ]).start(() => setShowSplash(false));
    }, 2500);

    return () => clearTimeout(timer);
  }, []);

  // Enhanced button animations
  useEffect(() => {
    if (!showSplash && !showCamera) {
      // Fade in main screen
      Animated.timing(fadeAnim, {
        toValue: 1,
        duration: 1000,
        useNativeDriver: true,
        easing: Easing.out(Easing.cubic),
      }).start();

      // Slide up main content
      Animated.timing(slideAnim, {
        toValue: 0,
        duration: 1000,
        useNativeDriver: true,
        easing: Easing.out(Easing.cubic),
      }).start();

      // Pulse animation for main button
      Animated.loop(
        Animated.sequence([
          Animated.timing(pulseAnim, {
            toValue: 1.1,
            duration: 1500,
            useNativeDriver: true,
            easing: Easing.inOut(Easing.ease),
          }),
          Animated.timing(pulseAnim, {
            toValue: 1,
            duration: 1500,
            useNativeDriver: true,
            easing: Easing.inOut(Easing.ease),
          }),
        ])
      ).start();
    }
  }, [showSplash, showCamera, pulseAnim, fadeAnim, slideAnim]);

  // Recording pulse animation
  useEffect(() => {
    if (isRecording) {
      Animated.loop(
        Animated.sequence([
          Animated.timing(recordPulseAnim, {
            toValue: 1.2,
            duration: 600,
            useNativeDriver: true,
            easing: Easing.inOut(Easing.ease),
          }),
          Animated.timing(recordPulseAnim, {
            toValue: 1,
            duration: 600,
            useNativeDriver: true,
            easing: Easing.inOut(Easing.ease),
          }),
        ])
      ).start();
    } else {
      recordPulseAnim.setValue(1);
    }
  }, [isRecording, recordPulseAnim]);

  // Status fade animation
  useEffect(() => {
    Animated.timing(statusFadeAnim, {
      toValue: 1,
      duration: 500,
      useNativeDriver: true,
    }).start();
  }, [uploadStatus, statusFadeAnim]);

  // Request all necessary permissions
  const requestPermissions = async () => {
    const cameraPermission: CameraPermissionStatus = await Camera.requestCameraPermission();
    const micPermission: CameraPermissionStatus = await Camera.requestMicrophonePermission();
    
    let locationPermission = false;
    if (Platform.OS === 'android') {
      locationPermission = await PermissionsAndroid.check(
        PermissionsAndroid.PERMISSIONS.ACCESS_FINE_LOCATION
      );
      if (!locationPermission) {
        locationPermission = (await PermissionsAndroid.request(
          PermissionsAndroid.PERMISSIONS.ACCESS_FINE_LOCATION
        )) === 'granted';
      }
      } else {
      locationPermission = true;
    }

    const granted = cameraPermission === 'granted' && micPermission === 'granted';
    setHasPermission(granted);

    if (Platform.OS === 'android' && granted) {
      await PermissionsAndroid.request(PermissionsAndroid.PERMISSIONS.RECORD_AUDIO);
    }
    
    return granted;
  };
  
  // Start tracking device orientation
  const startOrientationTracking = () => {
    Dimensions.addEventListener('change', ({ window }) => {
      setDeviceOrientation(
        window.width > window.height ? 'landscape' : 'portrait'
      );
    });
  };
  
  // Start gyroscope tracking
  const startGyroTracking = async () => {
    try {
      if (Platform.OS === 'android' && NativeModules.DeviceMotion) {
        const DeviceMotion = new NativeEventEmitter(NativeModules.DeviceMotion);
        gyroSubscription.current = DeviceMotion.addListener(
          'RotationRate',
          (data) => {
            setGyroData({
              x: data.x,
              y: data.y,
              z: data.z
            });
          }
        );
      }
    } catch (error) {
      console.warn('Gyroscope not available', error);
    }
  };
  
  // Start location tracking
  const startLocationTracking = async () => {
    try {
      if (Platform.OS === 'android' && NativeModules.LocationManager) {
        const LocationManager = new NativeEventEmitter(NativeModules.LocationManager);
        locationSubscription.current = LocationManager.addListener(
          'onLocationChanged',
          (location) => {
            setLocation({
              latitude: location.latitude,
              longitude: location.longitude,
              accuracy: location.accuracy
            });
          }
        );
      }
    } catch (error) {
      console.warn('Location tracking not available', error);
    }
  };
  
  // Get device info
  const getDeviceInfo = () => {
    return {
      brand: Platform.OS === 'android' ? Platform.constants.Brand : 'Apple',
      model: Platform.OS === 'android' ? Platform.constants.Model : 'iOS Device',
      os: Platform.OS,
      osVersion: Platform.Version.toString(),
    };
  };
  
  // Generate metadata for recording
  const generateMetadata = (): RecordingMetadata => {
    const { width, height } = Dimensions.get('window');
    const { scale, fontScale } = Dimensions.get('screen');
    
    return {
      deviceId: deviceId,
      timestamp: new Date().toISOString(),
      location: location || undefined,
      deviceInfo: getDeviceInfo(),
      cameraInfo: {
        id: device?.id || 'unknown',
        position: device?.position?.toString() || 'back',
        resolution: {
          width: device?.formats?.[0]?.videoWidth || 1920,
          height: device?.formats?.[0]?.videoHeight || 1080,
        },
      },
      viewport: {
        width,
        height,
        scale,
        fontScale,
      },
      orientation: deviceOrientation,
      gyro: gyroData || undefined,
      recordingSettings: {
        codec: 'h264',
        quality: '360p',
        bitrate: 2000000,
      },
    };
  };

  const handleOpenCamera = async () => {
    const granted = await requestPermissions();
    if (granted) {
      setShowCamera(true);
      startOrientationTracking();
      startGyroTracking();
      startLocationTracking();
    }
  };
  
  // Cleanup function for effects
  useEffect(() => {
    return () => {
      if (gyroSubscription.current) {
        gyroSubscription.current.remove();
      }
      if (locationSubscription.current) {
        locationSubscription.current.remove();
      }
    };
  }, []);

  // Start recording session with backend
  const handleStartRecording = async () => {
    if (!camera.current) return;
    
    try {
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
      
      startRecordingSegment();
      
      const timer = setInterval(() => {
        restartRecordingSegment();  
      }, 10000);
      
      recordingTimer.current = timer;
      
    } catch (error) {
      console.error('Failed to start recording session:', error);
      Alert.alert('Error', 'Failed to start recording session');
    }
  };
  
  const startRecordingSegment = () => {
    if (!camera.current) return;
    
    const metadata = generateMetadata();
    
    camera.current.startRecording({
      fileType: 'mp4',
      onRecordingFinished: async (video) => {
        console.log('Video segment saved to:', video.path);
        
        try {
          setUploadStatus('Uploading...');
          const uploadResponse = await uploadVideoChunk(video.path, metadata);
          console.log('Video uploaded:', uploadResponse);
          setUploadStatus('Uploaded successfully');
          
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
        setTimeout(() => {
          startRecordingSegment();
        }, 250);
      }
    } catch (error) {
      console.error('Error restarting recording segment:', error);
      setUploadStatus('Error restarting');
    } finally {
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

    if (recordingTimer.current) {
      clearInterval(recordingTimer.current);
      recordingTimer.current = null;
    }

    try {
      if (camera.current) {
        await camera.current.stopRecording();
      }

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

  // Enhanced splash screen
  if (showSplash) {
    return (
      <SafeAreaView style={styles.splashContainer}>
        <StatusBar barStyle="light-content" backgroundColor="#1a1a2e" />
        <Animated.View 
          style={[
            styles.splashContent,
            {
              opacity: fadeAnim,
              transform: [{ translateY: slideAnim }]
            }
          ]}
        >
          <View style={styles.logoContainer}>
            <View style={styles.logoCircle}>
              <Text style={styles.logoText}>HC</Text>
            </View>
          </View>
          <Text style={styles.splashTitle}>Heimdall Cam</Text>
          <Text style={styles.splashSubtitle}>Professional Video Recording</Text>
          <View style={styles.loadingDots}>
            <View style={[styles.dot, styles.dot1]} />
            <View style={[styles.dot, styles.dot2]} />
            <View style={[styles.dot, styles.dot3]} />
          </View>
        </Animated.View>
      </SafeAreaView>
    );
  }

  // Enhanced main screen
  if (!showCamera) {
    return (
      <SafeAreaView style={styles.mainContainer}>
        <StatusBar barStyle="light-content" backgroundColor="#1a1a2e" />
        <Animated.View 
          style={[
            styles.mainContent,
            {
              opacity: fadeAnim,
              transform: [{ translateY: slideAnim }]
            }
          ]}
        >
          <View style={styles.header}>
            <View style={styles.logoContainer}>
              <View style={styles.logoCircle}>
                <Text style={styles.logoText}>HC</Text>
              </View>
            </View>
            <Text style={styles.mainTitle}>Heimdall Cam</Text>
            <Text style={styles.mainSubtitle}>Professional Video Recording</Text>
          </View>

          <Animated.View style={{ transform: [{ scale: pulseAnim }] }}>
            <TouchableOpacity style={styles.openButton} onPress={handleOpenCamera}>
              <Text style={styles.buttonText}>Start Recording</Text>
            </TouchableOpacity>
          </Animated.View>

          <View style={styles.footer}>
            <View style={styles.deviceInfo}>
              <Text style={styles.deviceLabel}>Device ID</Text>
              <Text style={styles.deviceValue}>{deviceId.substring(0, 8)}</Text>
            </View>
          </View>
        </Animated.View>
      </SafeAreaView>
    );
  }

  // Enhanced loading screen
  if (!device || !hasPermission) {
    return (
      <SafeAreaView style={styles.loadingContainer}>
        <StatusBar barStyle="light-content" backgroundColor="#1a1a2e" />
        <View style={styles.loadingContent}>
          <View style={styles.loadingSpinner}>
            <View style={styles.spinnerRing} />
            <Text style={styles.loadingText}>📹</Text>
          </View>
          <Text style={styles.loadingTitle}>Initializing Camera</Text>
          <Text style={styles.loadingSubtitle}>Please wait...</Text>
        </View>
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={styles.cameraContainer}>
      <StatusBar barStyle="light-content" backgroundColor="#000000" />
      <Camera
        ref={camera}
        style={StyleSheet.absoluteFill}
        device={device}
        format={selectedFormat || undefined}
        isActive={true}
        video={true}
        audio={true}
      />
      
      {/* Enhanced top status bar */}
      <View style={styles.cameraTopBar}>
        <Animated.View 
          style={[
            styles.statusIndicator,
            { opacity: statusFadeAnim }
          ]}
        >
          <View style={[
            styles.statusDot,
            { backgroundColor: uploadStatus.includes('error') ? '#e74c3c' : 
                           uploadStatus.includes('Uploaded') ? '#27ae60' : 
                           uploadStatus.includes('Recording') ? '#f39c12' : '#95a5a6' }
          ]} />
          <Text style={styles.statusText}>{uploadStatus}</Text>
        </Animated.View>
        
        {sessionId && (
          <View style={styles.sessionInfo}>
            <Text style={styles.sessionLabel}>Session</Text>
            <Text style={styles.sessionText}>{sessionId.substring(0, 8)}</Text>
          </View>
        )}
      </View>

      {/* Enhanced recording indicator */}
      {isRecording && (
        <Animated.View 
          style={[
            styles.recordingIndicator,
            { transform: [{ scale: recordPulseAnim }] }
          ]}
        >
          <View style={styles.recordingDot} />
          <Text style={styles.recordingText}>REC</Text>
        </Animated.View>
      )}

      {/* Enhanced camera controls */}
      <View style={styles.cameraControls}>
        <View style={styles.controlButtons}>
          {!isRecording ? (
            <TouchableOpacity
              style={[styles.controlButton, styles.recordButton]}
              onPress={handleStartRecording}
            >
              <View style={styles.buttonInner}>
                <Text style={styles.buttonLabel}>Record</Text>
              </View>
            </TouchableOpacity>
          ) : (
            <TouchableOpacity
              style={[styles.controlButton, styles.stopButton]}
              onPress={handleStopRecording}
            >
              <View style={styles.buttonInner}>
                <Text style={styles.buttonLabel}>Stop</Text>
              </View>
            </TouchableOpacity>
          )}
          
          {!isRecording && (
            <TouchableOpacity
              style={[styles.controlButton, styles.closeButton]}
              onPress={handleCloseCamera}
            >
              <View style={styles.buttonInner}>
                <Text style={styles.buttonLabel}>Close</Text>
              </View>
            </TouchableOpacity>
          )}
        </View>
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  // Enhanced Splash Screen Styles
  splashContainer: {
    flex: 1,
    backgroundColor: '#1a1a2e',
  },
  splashContent: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    paddingHorizontal: 40,
  },
  logoContainer: {
    marginBottom: 30,
  },
  logoCircle: {
    width: 140,
    height: 140,
    borderRadius: 70,
    backgroundColor: '#4a90e2',
    justifyContent: 'center',
    alignItems: 'center',
    shadowColor: '#4a90e2',
    shadowOffset: { width: 0, height: 0 },
    shadowOpacity: 0.4,
    shadowRadius: 20,
    elevation: 10,
  },
  logoText: {
    color: 'white',
    fontSize: 40,
    fontWeight: 'bold',
    letterSpacing: 2,
  },
  splashTitle: {
    color: 'white',
    fontSize: 46,
    fontWeight: 'bold',
    letterSpacing: 3,
    marginBottom: 10,
    textAlign: 'center',
  },
  splashSubtitle: {
    color: '#b8c5d6',
    fontSize: 20,
    fontWeight: '300',
    textAlign: 'center',
    marginBottom: 40,
  },
  loadingDots: {
    flexDirection: 'row',
    justifyContent: 'center',
    alignItems: 'center',
  },
  dot: {
    width: 10,
    height: 10,
    borderRadius: 5,
    backgroundColor: '#4a90e2',
    marginHorizontal: 6,
  },
  dot1: { opacity: 0.3 },
  dot2: { opacity: 0.6 },
  dot3: { opacity: 1 },

  // Enhanced Main Screen Styles
  mainContainer: {
    flex: 1,
    backgroundColor: '#1a1a2e',
  },
  mainContent: {
    flex: 1,
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingHorizontal: 30,
    paddingVertical: 40,
  },
  header: {
    alignItems: 'center',
    marginTop: 40,
  },
  mainTitle: {
    color: 'white',
    fontSize: 40,
    fontWeight: 'bold',
    letterSpacing: 2,
    marginBottom: 10,
    textAlign: 'center',
  },
  mainSubtitle: {
    color: '#b8c5d6',
    fontSize: 18,
    fontWeight: '300',
    textAlign: 'center',
    lineHeight: 26,
  },
  openButton: {
    backgroundColor: '#4a90e2',
    paddingVertical: 18,
    paddingHorizontal: 40,
    borderRadius: 8,
    minWidth: 200,
    alignItems: 'center',
    shadowColor: '#4a90e2',
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.3,
    shadowRadius: 8,
    elevation: 6,
  },
  buttonText: {
    color: 'white',
    fontSize: 18,
    fontWeight: '600',
    letterSpacing: 0.5,
  },
  footer: {
    marginBottom: 20,
  },
  deviceInfo: {
    alignItems: 'center',
    paddingHorizontal: 20,
    paddingVertical: 10,
    backgroundColor: 'rgba(255, 255, 255, 0.08)',
    borderRadius: 20,
    borderWidth: 1,
    borderColor: 'rgba(255, 255, 255, 0.1)',
  },
  deviceLabel: {
    color: '#95a5a6',
    fontSize: 12,
    fontWeight: '500',
    marginBottom: 4,
  },
  deviceValue: {
    color: '#ffffff',
    fontSize: 14,
    fontWeight: 'bold',
  },

  // Enhanced Loading Screen Styles
  loadingContainer: {
    flex: 1,
    backgroundColor: '#1a1a2e',
  },
  loadingContent: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    paddingHorizontal: 40,
  },
  loadingSpinner: {
    width: 100,
    height: 100,
    borderRadius: 50,
    justifyContent: 'center',
    alignItems: 'center',
    marginBottom: 30,
    position: 'relative',
  },
  spinnerRing: {
    position: 'absolute',
    width: 100,
    height: 100,
    borderRadius: 50,
    borderWidth: 3,
    borderColor: 'rgba(74, 144, 226, 0.3)',
    borderTopColor: '#4a90e2',
  },
  loadingText: {
    fontSize: 36,
  },
  loadingTitle: {
    color: 'white',
    fontSize: 28,
    fontWeight: 'bold',
    marginBottom: 10,
    textAlign: 'center',
  },
  loadingSubtitle: {
    color: '#b8c5d6',
    fontSize: 18,
    textAlign: 'center',
  },

  // Enhanced Camera Screen Styles
  cameraContainer: {
    flex: 1,
    backgroundColor: 'black',
  },
  cameraTopBar: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingHorizontal: 20,
    paddingTop: 10,
    paddingBottom: 15,
    backgroundColor: 'rgba(26, 26, 46, 0.9)',
  },
  statusIndicator: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: 'rgba(0, 0, 0, 0.7)',
    paddingHorizontal: 15,
    paddingVertical: 8,
    borderRadius: 25,
    borderWidth: 1,
    borderColor: 'rgba(255, 255, 255, 0.1)',
  },
  statusDot: {
    width: 10,
    height: 10,
    borderRadius: 5,
    marginRight: 10,
  },
  statusText: {
    color: 'white',
    fontSize: 14,
    fontWeight: '600',
  },
  sessionInfo: {
    backgroundColor: 'rgba(0, 0, 0, 0.7)',
    paddingHorizontal: 15,
    paddingVertical: 8,
    borderRadius: 25,
    borderWidth: 1,
    borderColor: 'rgba(255, 255, 255, 0.1)',
    alignItems: 'center',
  },
  sessionLabel: {
    color: '#95a5a6',
    fontSize: 10,
    fontWeight: '500',
    marginBottom: 2,
  },
  sessionText: {
    color: '#ffffff',
    fontSize: 12,
    fontWeight: 'bold',
  },
  recordingIndicator: {
    position: 'absolute',
    top: 100,
    right: 20,
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#e74c3c',
    paddingHorizontal: 15,
    paddingVertical: 8,
    borderRadius: 25,
  },
  recordingDot: {
    width: 10,
    height: 10,
    borderRadius: 5,
    backgroundColor: 'white',
    marginRight: 8,
  },
  recordingText: {
    color: 'white',
    fontSize: 14,
    fontWeight: 'bold',
  },
  cameraControls: {
    position: 'absolute',
    bottom: 0,
    left: 0,
    right: 0,
    paddingHorizontal: 30,
    paddingBottom: 40,
    paddingTop: 20,
    backgroundColor: 'rgba(26, 26, 46, 0.9)',
  },
  controlButtons: {
    flexDirection: 'row',
    justifyContent: 'center',
    alignItems: 'center',
    gap: 25,
  },
  controlButton: {
    paddingVertical: 16,
    paddingHorizontal: 28,
    borderRadius: 8,
    minWidth: 110,
    alignItems: 'center',
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.3,
    shadowRadius: 8,
    elevation: 6,
  },
  recordButton: {
    backgroundColor: '#4a90e2',
  },
  stopButton: {
    backgroundColor: '#7f8c8d',
  },
  closeButton: {
    backgroundColor: '#34495e',
  },
  buttonInner: {
    alignItems: 'center',
  },
  buttonLabel: {
    color: 'white',
    fontSize: 16,
    fontWeight: '600',
    marginTop: 4,
  },
});
