require('dotenv').config();
const { aiplatform } = require('@google-cloud/aiplatform');
const vision = require('@google-cloud/vision');
const videoIntelligence = require('@google-cloud/video-intelligence').v1;
const { GoogleAuth } = require('google-auth-library');
const axios = require('axios');
const firebase = require('../config/firebase');

// Configuration
const GCLOUD_PROJECT_ID = process.env.GCLOUD_PROJECT_ID;
const LOCATION_ID = process.env.LOCATION_ID || 'us-central1';

// Initialize AI clients
let visionClient, videoClient, predictionClient;

async function initializeAIServices() {
  try {
    const auth = new GoogleAuth({
      keyFilename: process.env.GCLOUD_KEYFILE,
      scopes: ['https://www.googleapis.com/auth/cloud-platform']
    });

    visionClient = new vision.ImageAnnotatorClient({
      keyFilename: process.env.GCLOUD_KEYFILE,
    });

    videoClient = new videoIntelligence.VideoIntelligenceServiceClient({
      keyFilename: process.env.GCLOUD_KEYFILE,
    });

    predictionClient = new aiplatform.PredictionServiceClient({
      keyFilename: process.env.GCLOUD_KEYFILE,
    });

    console.log('✅ AI Services initialized successfully');
    return true;
  } catch (error) {
    console.error('❌ AI Services initialization failed:', error.message);
    return false;
  }
}

// Crowd Analysis and Bottleneck Prediction
class CrowdAnalyzer {
  static async analyzeCrowdDensity(imageBuffer, metadata = {}) {
    try {
      if (!visionClient) {
        throw new Error('Vision client not initialized');
      }

      // Detect objects (people) in the image
      const [result] = await visionClient.objectLocalization(imageBuffer);
      const objects = result.localizedObjectAnnotations || [];
      
      // Count people
      const people = objects.filter(obj => obj.name === 'Person');
      const density = people.length;

      // Analyze crowd distribution
      const crowdZones = this.analyzeCrowdDistribution(people, metadata);
      
      // Calculate crowd flow metrics
      const flowMetrics = this.calculateFlowMetrics(people, metadata);

      // Store analysis in Firebase
      const analysis = {
        timestamp: new Date().toISOString(),
        density,
        peopleCount: people.length,
        crowdZones,
        flowMetrics,
        metadata,
        boundingBoxes: people.map(person => person.boundingPoly),
        confidence: people.reduce((sum, p) => sum + p.score, 0) / people.length || 0
      };

      await this.storeAnalysis('crowd_density', analysis);
      
      return analysis;
    } catch (error) {
      console.error('❌ Crowd density analysis failed:', error.message);
      throw error;
    }
  }

  static analyzeCrowdDistribution(people, metadata) {
    // Divide image into zones and count people in each
    const zones = {
      topLeft: 0,
      topRight: 0,
      bottomLeft: 0,
      bottomRight: 0,
      center: 0
    };

    people.forEach(person => {
      const box = person.boundingPoly;
      if (box && box.normalizedVertices && box.normalizedVertices.length > 0) {
        const centerX = box.normalizedVertices.reduce((sum, v) => sum + v.x, 0) / box.normalizedVertices.length;
        const centerY = box.normalizedVertices.reduce((sum, v) => sum + v.y, 0) / box.normalizedVertices.length;

        if (centerX < 0.33 && centerY < 0.33) zones.topLeft++;
        else if (centerX > 0.66 && centerY < 0.33) zones.topRight++;
        else if (centerX < 0.33 && centerY > 0.66) zones.bottomLeft++;
        else if (centerX > 0.66 && centerY > 0.66) zones.bottomRight++;
        else zones.center++;
      }
    });

    return zones;
  }

  static calculateFlowMetrics(people, metadata) {
    // Basic flow analysis - would be enhanced with temporal data
    return {
      averageCrowdSpeed: metadata.estimatedSpeed || 'unknown',
      flowDirection: metadata.flowDirection || 'unknown',
      congestionLevel: people.length > 20 ? 'high' : people.length > 10 ? 'medium' : 'low'
    };
  }

  static async predictBottlenecks(historicalData, currentConditions) {
    try {
      // Use time series forecasting to predict crowd bottlenecks
      const predictionData = {
        currentDensity: currentConditions.density,
        timeOfDay: new Date().getHours(),
        dayOfWeek: new Date().getDay(),
        weatherConditions: currentConditions.weather || 'unknown',
        eventType: currentConditions.eventType || 'general'
      };

      // For now, use heuristic-based prediction
      // In production, this would use Vertex AI Forecasting
      const bottleneckRisk = this.calculateBottleneckRisk(predictionData, historicalData);
      
      const prediction = {
        timestamp: new Date().toISOString(),
        predictedBottleneckTime: new Date(Date.now() + 15 * 60 * 1000).toISOString(), // 15 minutes
        riskLevel: bottleneckRisk.level,
        riskScore: bottleneckRisk.score,
        suggestedActions: bottleneckRisk.actions,
        affectedZones: bottleneckRisk.zones
      };

      await this.storeAnalysis('bottleneck_prediction', prediction);
      
      // Trigger alerts if high risk
      if (bottleneckRisk.level === 'high') {
        await this.triggerBottleneckAlert(prediction);
      }

      return prediction;
    } catch (error) {
      console.error('❌ Bottleneck prediction failed:', error.message);
      throw error;
    }
  }

  static calculateBottleneckRisk(current, historical) {
    let score = 0;
    let level = 'low';
    let actions = [];
    let zones = [];

    // High density risk
    if (current.currentDensity > 30) {
      score += 40;
      actions.push('Deploy crowd control personnel');
      zones.push('high-density-areas');
    } else if (current.currentDensity > 20) {
      score += 20;
    }

    // Time-based risk
    if (current.timeOfDay >= 12 && current.timeOfDay <= 14) { // Lunch hours
      score += 15;
      actions.push('Open additional service points');
    }

    // Event-specific risk
    if (current.eventType === 'concert' || current.eventType === 'sports') {
      score += 25;
      actions.push('Prepare emergency exits');
      zones.push('main-entrance', 'stage-area');
    }

    if (score >= 60) level = 'high';
    else if (score >= 30) level = 'medium';

    return { level, score, actions, zones };
  }

  static async triggerBottleneckAlert(prediction) {
    const alert = {
      type: 'BOTTLENECK_WARNING',
      severity: 'HIGH',
      timestamp: new Date().toISOString(),
      prediction,
      message: `High risk of bottleneck predicted in ${prediction.affectedZones.join(', ')}`,
      suggestedActions: prediction.suggestedActions
    };

    await firebase.db?.ref('alerts/bottleneck').push(alert);
    console.log('🚨 Bottleneck alert triggered:', alert.message);
  }

  static async storeAnalysis(type, data) {
    if (firebase.db) {
      await firebase.db.ref(`analysis/${type}`).push(data);
    }
  }
}

// Anomaly Detection
class AnomalyDetector {
  static async detectAnomalies(videoBuffer, metadata = {}) {
    try {
      const [result] = await videoClient.annotateVideo({
        inputContent: videoBuffer,
        features: [
          'OBJECT_TRACKING',
          'PERSON_DETECTION',
          'LOGO_RECOGNITION',
          'TEXT_DETECTION'
        ],
        videoContext: {
          personDetectionConfig: {
            includeBoundingBoxes: true,
            includeAttributes: true,
          }
        }
      });

      const anomalies = [];

      // Detect unusual movements
      if (result.annotationResults && result.annotationResults[0]) {
        const annotations = result.annotationResults[0];
        
        // Analyze person detection for unusual behavior
        if (annotations.personDetectionAnnotations) {
          const personAnomalies = this.detectPersonAnomalies(annotations.personDetectionAnnotations);
          anomalies.push(...personAnomalies);
        }

        // Detect unusual objects
        if (annotations.objectAnnotations) {
          const objectAnomalies = this.detectObjectAnomalies(annotations.objectAnnotations);
          anomalies.push(...objectAnomalies);
        }
      }

      const analysis = {
        timestamp: new Date().toISOString(),
        anomalies,
        metadata,
        severity: this.calculateSeverity(anomalies)
      };

      await CrowdAnalyzer.storeAnalysis('anomaly_detection', analysis);

      // Trigger alerts for high-severity anomalies
      if (analysis.severity === 'high') {
        await this.triggerAnomalyAlert(analysis);
      }

      return analysis;
    } catch (error) {
      console.error('❌ Anomaly detection failed:', error.message);
      throw error;
    }
  }

  static detectPersonAnomalies(personDetections) {
    const anomalies = [];

    personDetections.forEach(detection => {
      if (detection.tracks) {
        detection.tracks.forEach(track => {
          // Detect rapid movement (potential panic)
          if (track.timestampedObjects && track.timestampedObjects.length > 1) {
            const movements = this.calculateMovements(track.timestampedObjects);
            
            if (movements.averageSpeed > 0.8) { // Threshold for rapid movement
              anomalies.push({
                type: 'RAPID_MOVEMENT',
                severity: 'medium',
                description: 'Detected rapid person movement, possible panic or emergency',
                trackId: track.trackId,
                confidence: track.confidence || 0.5
              });
            }

            // Detect erratic movement patterns
            if (movements.erraticPattern) {
              anomalies.push({
                type: 'ERRATIC_MOVEMENT',
                severity: 'high',
                description: 'Detected erratic movement pattern, possible distress',
                trackId: track.trackId,
                confidence: track.confidence || 0.5
              });
            }
          }
        });
      }
    });

    return anomalies;
  }

  static detectObjectAnomalies(objectAnnotations) {
    const anomalies = [];
    const suspiciousObjects = ['weapon', 'knife', 'gun', 'smoke', 'fire'];

    objectAnnotations.forEach(obj => {
      if (suspiciousObjects.some(suspicious => 
        obj.entity && obj.entity.description && 
        obj.entity.description.toLowerCase().includes(suspicious)
      )) {
        anomalies.push({
          type: 'SUSPICIOUS_OBJECT',
          severity: 'critical',
          description: `Detected suspicious object: ${obj.entity.description}`,
          confidence: obj.confidence || 0.5,
          object: obj.entity.description
        });
      }
    });

    return anomalies;
  }

  static calculateMovements(timestampedObjects) {
    let totalDistance = 0;
    let erraticPattern = false;
    
    for (let i = 1; i < timestampedObjects.length; i++) {
      const prev = timestampedObjects[i - 1];
      const curr = timestampedObjects[i];
      
      if (prev.normalizedBoundingBox && curr.normalizedBoundingBox) {
        const distance = Math.sqrt(
          Math.pow(curr.normalizedBoundingBox.left - prev.normalizedBoundingBox.left, 2) +
          Math.pow(curr.normalizedBoundingBox.top - prev.normalizedBoundingBox.top, 2)
        );
        totalDistance += distance;

        // Detect sudden direction changes (erratic pattern)
        if (distance > 0.3) { // Large sudden movement
          erraticPattern = true;
        }
      }
    }

    return {
      averageSpeed: totalDistance / timestampedObjects.length,
      erraticPattern
    };
  }

  static calculateSeverity(anomalies) {
    if (anomalies.some(a => a.severity === 'critical')) return 'critical';
    if (anomalies.some(a => a.severity === 'high')) return 'high';
    if (anomalies.some(a => a.severity === 'medium')) return 'medium';
    return 'low';
  }

  static async triggerAnomalyAlert(analysis) {
    const alert = {
      type: 'ANOMALY_DETECTED',
      severity: analysis.severity.toUpperCase(),
      timestamp: new Date().toISOString(),
      anomalies: analysis.anomalies,
      message: `${analysis.anomalies.length} anomalies detected`,
      requiresImmedateAction: analysis.severity === 'critical'
    };

    await firebase.db?.ref('alerts/anomalies').push(alert);
    console.log('🚨 Anomaly alert triggered:', alert.message);
  }
}

// Threat Recognition
class ThreatRecognizer {
  static async recognizeThreats(mediaBuffer, mediaType = 'image', metadata = {}) {
    try {
      let threats = [];

      if (mediaType === 'image') {
        threats = await this.recognizeImageThreats(mediaBuffer, metadata);
      } else if (mediaType === 'video') {
        threats = await this.recognizeVideoThreats(mediaBuffer, metadata);
      }

      const analysis = {
        timestamp: new Date().toISOString(),
        mediaType,
        threats,
        metadata,
        threatLevel: this.calculateThreatLevel(threats)
      };

      await CrowdAnalyzer.storeAnalysis('threat_recognition', analysis);

      // Trigger immediate alerts for critical threats
      if (analysis.threatLevel === 'critical') {
        await this.triggerThreatAlert(analysis);
      }

      return analysis;
    } catch (error) {
      console.error('❌ Threat recognition failed:', error.message);
      throw error;
    }
  }

  static async recognizeImageThreats(imageBuffer, metadata) {
    const threats = [];

    // Use Vision API for object detection
    const [objects] = await visionClient.objectLocalization(imageBuffer);
    const [labels] = await visionClient.labelDetection(imageBuffer);
    const [text] = await visionClient.textDetection(imageBuffer);

    // Check for weapon-like objects
    const weaponKeywords = ['gun', 'knife', 'weapon', 'pistol', 'rifle'];
    objects.localizedObjectAnnotations?.forEach(obj => {
      if (weaponKeywords.some(keyword => 
        obj.name.toLowerCase().includes(keyword)
      )) {
        threats.push({
          type: 'WEAPON_DETECTED',
          severity: 'critical',
          description: `Potential weapon detected: ${obj.name}`,
          confidence: obj.score,
          location: obj.boundingPoly
        });
      }
    });

    // Check for fire/smoke indicators
    const hazardKeywords = ['fire', 'smoke', 'explosion', 'flame'];
    labels.labelAnnotations?.forEach(label => {
      if (hazardKeywords.some(keyword => 
        label.description.toLowerCase().includes(keyword)
      )) {
        threats.push({
          type: 'FIRE_SMOKE_DETECTED',
          severity: 'high',
          description: `Fire/smoke indicator detected: ${label.description}`,
          confidence: label.score
        });
      }
    });

    // Check for threatening text
    if (text.textAnnotations && text.textAnnotations.length > 0) {
      const threatWords = ['bomb', 'attack', 'kill', 'terrorist', 'explosion'];
      const detectedText = text.textAnnotations[0].description.toLowerCase();
      
      threatWords.forEach(word => {
        if (detectedText.includes(word)) {
          threats.push({
            type: 'THREATENING_TEXT',
            severity: 'high',
            description: `Threatening text detected containing: ${word}`,
            confidence: 0.8,
            text: detectedText
          });
        }
      });
    }

    return threats;
  }

  static async recognizeVideoThreats(videoBuffer, metadata) {
    // Similar to image but for video analysis
    const threats = [];
    
    // This would use more sophisticated video analysis
    // For now, treating as image frames
    return threats;
  }

  static calculateThreatLevel(threats) {
    if (threats.some(t => t.severity === 'critical')) return 'critical';
    if (threats.some(t => t.severity === 'high')) return 'high';
    if (threats.some(t => t.severity === 'medium')) return 'medium';
    return 'low';
  }

  static async triggerThreatAlert(analysis) {
    const alert = {
      type: 'THREAT_DETECTED',
      severity: 'CRITICAL',
      timestamp: new Date().toISOString(),
      threats: analysis.threats,
      message: `${analysis.threats.length} threats detected - IMMEDIATE ACTION REQUIRED`,
      emergencyResponse: true
    };

    await firebase.db?.ref('alerts/threats').push(alert);
    console.log('🚨 CRITICAL THREAT ALERT:', alert.message);
    
    // Trigger emergency protocols
    await this.triggerEmergencyProtocols(analysis);
  }

  static async triggerEmergencyProtocols(analysis) {
    // This would integrate with emergency dispatch system
    console.log('🚨 TRIGGERING EMERGENCY PROTOCOLS');
    // Implementation would depend on specific emergency procedures
  }
}

// Sentiment Analysis
class SentimentAnalyzer {
  static async analyzeCrowdSentiment(imageBuffer, metadata = {}) {
    try {
      // Use Vision API for face detection
      const [faces] = await visionClient.faceDetection(imageBuffer);
      
      if (!faces.faceAnnotations || faces.faceAnnotations.length === 0) {
        return {
          timestamp: new Date().toISOString(),
          faceCount: 0,
          averageSentiment: 'neutral',
          emotions: {},
          metadata
        };
      }

      const emotions = {
        joy: 0,
        sorrow: 0,
        anger: 0,
        surprise: 0,
        fear: 0,
        neutral: 0
      };

      faces.faceAnnotations.forEach(face => {
        if (face.joyLikelihood === 'LIKELY' || face.joyLikelihood === 'VERY_LIKELY') emotions.joy++;
        if (face.sorrowLikelihood === 'LIKELY' || face.sorrowLikelihood === 'VERY_LIKELY') emotions.sorrow++;
        if (face.angerLikelihood === 'LIKELY' || face.angerLikelihood === 'VERY_LIKELY') emotions.anger++;
        if (face.surpriseLikelihood === 'LIKELY' || face.surpriseLikelihood === 'VERY_LIKELY') emotions.surprise++;
        
        // Calculate fear/stress indicators
        if (face.angerLikelihood === 'LIKELY' || face.sorrowLikelihood === 'LIKELY') {
          emotions.fear++;
        } else {
          emotions.neutral++;
        }
      });

      const totalFaces = faces.faceAnnotations.length;
      const sentimentScores = {
        positive: emotions.joy / totalFaces,
        negative: (emotions.sorrow + emotions.anger + emotions.fear) / totalFaces,
        neutral: emotions.neutral / totalFaces
      };

      let averageSentiment = 'neutral';
      if (sentimentScores.positive > 0.4) averageSentiment = 'positive';
      else if (sentimentScores.negative > 0.3) averageSentiment = 'negative';

      const analysis = {
        timestamp: new Date().toISOString(),
        faceCount: totalFaces,
        averageSentiment,
        sentimentScores,
        emotions,
        stressLevel: sentimentScores.negative > 0.5 ? 'high' : sentimentScores.negative > 0.3 ? 'medium' : 'low',
        metadata
      };

      await CrowdAnalyzer.storeAnalysis('sentiment_analysis', analysis);

      // Alert if high stress detected
      if (analysis.stressLevel === 'high') {
        await this.triggerStressAlert(analysis);
      }

      return analysis;
    } catch (error) {
      console.error('❌ Sentiment analysis failed:', error.message);
      throw error;
    }
  }

  static async triggerStressAlert(analysis) {
    const alert = {
      type: 'HIGH_STRESS_DETECTED',
      severity: 'MEDIUM',
      timestamp: new Date().toISOString(),
      analysis,
      message: `High stress levels detected in crowd - ${analysis.faceCount} faces analyzed`,
      suggestedActions: ['Deploy calming personnel', 'Monitor for escalation', 'Prepare for crowd management']
    };

    await firebase.db?.ref('alerts/stress').push(alert);
    console.log('⚠️  High stress alert triggered');
  }
}

// Initialize services
initializeAIServices();

module.exports = {
  CrowdAnalyzer,
  AnomalyDetector,
  ThreatRecognizer,
  SentimentAnalyzer,
  initializeAIServices
}; 