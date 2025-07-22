import React, { useEffect, useRef, useState } from 'react';
import {
  View,
  StyleSheet,
  Text,
  TouchableOpacity,
  PermissionsAndroid,
  Platform,
} from 'react-native';
import {
  Camera,
  useCameraDevices,
  CameraPermissionStatus,
} from 'react-native-vision-camera';
import type { Camera as CameraType } from 'react-native-vision-camera';

export default function App() {
  const camera = useRef<CameraType>(null);
  const [isRecording, setIsRecording] = useState(false);
  const [hasPermission, setHasPermission] = useState(false);

  const devices = useCameraDevices();
  const device = devices.find(device => device.position === 'back');

  useEffect(() => {
    (async () => {
      const cameraPermission: CameraPermissionStatus = await Camera.requestCameraPermission();
      const micPermission: CameraPermissionStatus = await Camera.requestMicrophonePermission();

      setHasPermission(
        cameraPermission === 'granted' && micPermission === 'granted'
      );

      if (Platform.OS === 'android') {
        await PermissionsAndroid.request(PermissionsAndroid.PERMISSIONS.RECORD_AUDIO);
      }
    })();
  }, []);

  const startRecording = async () => {
    if (!camera.current) return;
    setIsRecording(true);

    camera.current.startRecording({
      onRecordingFinished: (video) => {
        console.log('Video saved to:', video.path);
        setIsRecording(false);
      },
      onRecordingError: (error) => {
        console.error('Recording error:', error);
        setIsRecording(false);
      },
    });
  };

  const stopRecording = async () => {
    if (!camera.current) return;
    await camera.current.stopRecording();
    setIsRecording(false);
  };

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
        <TouchableOpacity
          style={[styles.button, isRecording && styles.stopButton]}
          onPress={isRecording ? stopRecording : startRecording}
        >
          <Text style={styles.buttonText}>
            {isRecording ? 'Stop' : 'Record'}
          </Text>
        </TouchableOpacity>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
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
  },
  button: {
    backgroundColor: 'red',
    padding: 18,
    borderRadius: 50,
  },
  stopButton: {
    backgroundColor: 'gray',
  },
  buttonText: {
    color: 'white',
    fontSize: 18,
    fontWeight: 'bold',
  },
});
