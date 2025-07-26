require('dotenv').config();
const firebase = require('../config/firebase');
const axios = require('axios');
const nodemailer = require('nodemailer');
const twilio = require('twilio');

// Configuration
const GOOGLE_MAPS_API_KEY = process.env.GOOGLE_MAPS_API_KEY;
const TWILIO_ACCOUNT_SID = process.env.TWILIO_ACCOUNT_SID;
const TWILIO_AUTH_TOKEN = process.env.TWILIO_AUTH_TOKEN;
const TWILIO_PHONE_NUMBER = process.env.TWILIO_PHONE_NUMBER;

// Initialize services
let twilioClient, emailTransporter;

function initializeDispatchServices() {
  try {
    // Initialize Twilio for SMS/calls
    if (TWILIO_ACCOUNT_SID && TWILIO_AUTH_TOKEN) {
      twilioClient = twilio(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN);
      console.log('✅ Twilio SMS service initialized');
    } else {
      console.warn('⚠️  Twilio not configured - SMS alerts disabled');
    }

    // Initialize email transporter
    if (process.env.EMAIL_SERVICE && process.env.EMAIL_USER && process.env.EMAIL_PASS) {
      emailTransporter = nodemailer.createTransporter({
        service: process.env.EMAIL_SERVICE,
        auth: {
          user: process.env.EMAIL_USER,
          pass: process.env.EMAIL_PASS
        }
      });
      console.log('✅ Email service initialized');
    } else {
      console.warn('⚠️  Email not configured - email alerts disabled');
    }

  } catch (error) {
    console.error('❌ Emergency dispatch services initialization failed:', error.message);
  }
}

// Emergency Types and Priority Levels
const EMERGENCY_TYPES = {
  MEDICAL: {
    priority: 1,
    responseTime: 5, // minutes
    requiredPersonnel: ['paramedic', 'security'],
    equipment: ['medical_kit', 'defibrillator']
  },
  FIRE: {
    priority: 1,
    responseTime: 3,
    requiredPersonnel: ['fire_safety', 'security', 'evacuation_coordinator'],
    equipment: ['fire_extinguisher', 'evacuation_equipment']
  },
  SECURITY_THREAT: {
    priority: 1,
    responseTime: 2,
    requiredPersonnel: ['security', 'law_enforcement'],
    equipment: ['radio', 'restraints']
  },
  CROWD_CONTROL: {
    priority: 2,
    responseTime: 7,
    requiredPersonnel: ['crowd_control', 'security'],
    equipment: ['barriers', 'megaphone']
  },
  LOST_PERSON: {
    priority: 3,
    responseTime: 10,
    requiredPersonnel: ['security', 'information_desk'],
    equipment: ['radio', 'first_aid']
  },
  TECHNICAL: {
    priority: 3,
    responseTime: 15,
    requiredPersonnel: ['maintenance', 'security'],
    equipment: ['tools', 'safety_equipment']
  }
};

class EmergencyDispatchSystem {
  
  // Main dispatch function
  static async dispatchEmergency(incident) {
    try {
      const incidentId = this.generateIncidentId();
      console.log(`🚨 Emergency dispatch initiated: ${incidentId}`);
      console.log(`📍 Incident type: ${incident.type}`);
      console.log(`📍 Location: ${incident.location?.description || 'Unknown'}`);

      // Validate incident data
      if (!this.validateIncident(incident)) {
        throw new Error('Invalid incident data provided');
      }

      // Create incident record
      const incidentRecord = {
        id: incidentId,
        type: incident.type,
        priority: EMERGENCY_TYPES[incident.type]?.priority || 3,
        timestamp: new Date().toISOString(),
        location: incident.location,
        description: incident.description,
        reportedBy: incident.reportedBy || 'AI_SYSTEM',
        status: 'DISPATCHING',
        alerts: [],
        responses: [],
        metadata: incident.metadata || {}
      };

      // Store incident in Firebase
      await this.storeIncident(incidentRecord);

      // Find available responders
      const availableResponders = await this.findNearestResponders(
        incident.location,
        EMERGENCY_TYPES[incident.type]?.requiredPersonnel || ['security'],
        3 // max responders
      );

      if (availableResponders.length === 0) {
        console.warn('⚠️  No available responders found');
        await this.escalateIncident(incidentRecord);
        return { success: false, error: 'No available responders', incidentId };
      }

      // Calculate optimal routes for responders
      const routingResults = await this.calculateOptimalRoutes(
        availableResponders,
        incident.location
      );

      // Assign responders and send alerts
      const assignments = [];
      for (let i = 0; i < Math.min(availableResponders.length, 2); i++) {
        const responder = availableResponders[i];
        const route = routingResults[i];

        const assignment = {
          responderId: responder.id,
          responderName: responder.name,
          estimatedArrival: route?.duration || 'unknown',
          route: route?.steps || [],
          assignedAt: new Date().toISOString(),
          status: 'DISPATCHED'
        };

        assignments.push(assignment);

        // Send alert to responder
        await this.sendResponderAlert(responder, incidentRecord, route);
      }

      // Update incident with assignments
      incidentRecord.assignments = assignments;
      incidentRecord.status = 'RESPONDING';
      await this.updateIncident(incidentRecord);

      // Send alert to command center
      await this.sendCommandCenterAlert(incidentRecord);

      // Set up monitoring for response
      this.monitorResponse(incidentRecord);

      console.log(`✅ Emergency dispatch completed for ${incidentId}`);
      console.log(`👮 ${assignments.length} responders assigned`);

      return {
        success: true,
        incidentId,
        assignments,
        estimatedResponse: Math.min(...assignments.map(a => 
          parseInt(a.estimatedArrival?.replace(' mins', '')) || 15
        ))
      };

    } catch (error) {
      console.error('❌ Emergency dispatch failed:', error.message);
      throw error;
    }
  }

  // Find nearest available responders
  static async findNearestResponders(incidentLocation, requiredSkills, maxCount = 3) {
    try {
      if (!firebase.db) {
        console.warn('⚠️  Firebase not available, using mock responders');
        return this.getMockResponders(maxCount);
      }

      // Get all active responders from Firebase
      const respondersSnapshot = await firebase.db.ref('responders').once('value');
      const responders = respondersSnapshot.val() || {};

      const availableResponders = [];

      for (const [id, responder] of Object.entries(responders)) {
        // Check if responder is available and has required skills
        if (responder.status === 'available' && 
            responder.skills?.some(skill => requiredSkills.includes(skill))) {
          
          // Calculate distance to incident
          const distance = await this.calculateDistance(
            responder.location,
            incidentLocation
          );

          availableResponders.push({
            id,
            ...responder,
            distanceToIncident: distance
          });
        }
      }

      // Sort by distance and return closest ones
      return availableResponders
        .sort((a, b) => (a.distanceToIncident?.duration || 999) - (b.distanceToIncident?.duration || 999))
        .slice(0, maxCount);

    } catch (error) {
      console.error('❌ Error finding responders:', error.message);
      return this.getMockResponders(maxCount);
    }
  }

  // Calculate distance and travel time using Google Maps API
  static async calculateDistance(fromLocation, toLocation) {
    try {
      if (!GOOGLE_MAPS_API_KEY) {
        console.warn('⚠️  Google Maps API not configured');
        return { duration: Math.floor(Math.random() * 10) + 2, distance: 'unknown' };
      }

      const origin = `${fromLocation.lat},${fromLocation.lng}`;
      const destination = `${toLocation.lat},${toLocation.lng}`;

      const response = await axios.get(
        `https://maps.googleapis.com/maps/api/distancematrix/json`, {
          params: {
            origins: origin,
            destinations: destination,
            mode: 'walking', // or 'driving' depending on venue
            units: 'metric',
            key: GOOGLE_MAPS_API_KEY
          }
        }
      );

      if (response.data.status === 'OK' && response.data.rows[0].elements[0].status === 'OK') {
        const element = response.data.rows[0].elements[0];
        return {
          duration: Math.ceil(element.duration.value / 60), // minutes
          distance: element.distance.text,
          durationText: element.duration.text
        };
      }

      throw new Error('Google Maps API error');
    } catch (error) {
      console.warn('⚠️  Distance calculation failed:', error.message);
      return { duration: Math.floor(Math.random() * 8) + 2, distance: 'unknown' };
    }
  }

  // Calculate optimal routes for multiple responders
  static async calculateOptimalRoutes(responders, destination) {
    const routes = [];

    for (const responder of responders) {
      try {
        const route = await this.getDetailedRoute(responder.location, destination);
        routes.push(route);
      } catch (error) {
        console.warn(`⚠️  Route calculation failed for responder ${responder.id}`);
        routes.push({ duration: '5 mins', steps: ['Head to incident location'] });
      }
    }

    return routes;
  }

  // Get detailed route with turn-by-turn directions
  static async getDetailedRoute(fromLocation, toLocation) {
    try {
      if (!GOOGLE_MAPS_API_KEY) {
        return { duration: '5 mins', steps: ['Navigate to incident location'] };
      }

      const origin = `${fromLocation.lat},${fromLocation.lng}`;
      const destination = `${toLocation.lat},${toLocation.lng}`;

      const response = await axios.get(
        `https://maps.googleapis.com/maps/api/directions/json`, {
          params: {
            origin,
            destination,
            mode: 'walking',
            key: GOOGLE_MAPS_API_KEY
          }
        }
      );

      if (response.data.status === 'OK' && response.data.routes.length > 0) {
        const route = response.data.routes[0];
        const leg = route.legs[0];

        return {
          duration: leg.duration.text,
          distance: leg.distance.text,
          steps: leg.steps.map(step => step.html_instructions.replace(/<[^>]*>/g, ''))
        };
      }

      throw new Error('No route found');
    } catch (error) {
      console.warn('⚠️  Detailed route calculation failed:', error.message);
      return { duration: '5 mins', steps: ['Navigate to incident location'] };
    }
  }

  // Send alert to assigned responder
  static async sendResponderAlert(responder, incident, route) {
    const message = this.formatResponderMessage(responder, incident, route);

    try {
      // Send push notification via Firebase
      if (firebase.messaging && responder.fcmToken) {
        await firebase.messaging.send({
          token: responder.fcmToken,
          notification: {
            title: `🚨 EMERGENCY DISPATCH`,
            body: `${incident.type} at ${incident.location?.description || 'Unknown location'}`
          },
          data: {
            incidentId: incident.id,
            type: incident.type,
            priority: incident.priority.toString(),
            estimatedArrival: route?.duration || 'unknown'
          }
        });
        console.log(`📱 Push notification sent to ${responder.name}`);
      }

      // Send SMS backup
      if (twilioClient && responder.phone) {
        await twilioClient.messages.create({
          body: message,
          from: TWILIO_PHONE_NUMBER,
          to: responder.phone
        });
        console.log(`📱 SMS sent to ${responder.name}`);
      }

      // Send email if available
      if (emailTransporter && responder.email) {
        await emailTransporter.sendMail({
          from: process.env.EMAIL_USER,
          to: responder.email,
          subject: `🚨 EMERGENCY DISPATCH - ${incident.type}`,
          html: this.formatResponderEmailAlert(responder, incident, route)
        });
        console.log(`📧 Email sent to ${responder.name}`);
      }

      // Update responder status
      await this.updateResponderStatus(responder.id, 'dispatched', incident.id);

    } catch (error) {
      console.error(`❌ Failed to send alert to ${responder.name}:`, error.message);
    }
  }

  // Send alert to command center
  static async sendCommandCenterAlert(incident) {
    try {
      const alert = {
        timestamp: new Date().toISOString(),
        type: 'EMERGENCY_DISPATCH',
        incident,
        message: `Emergency dispatch initiated: ${incident.type} at ${incident.location?.description}`,
        requiresAttention: incident.priority <= 2
      };

      // Store in Firebase for dashboard
      await firebase.db?.ref('command_center/alerts').push(alert);

      // Send to command center personnel
      if (emailTransporter && process.env.COMMAND_CENTER_EMAIL) {
        await emailTransporter.sendMail({
          from: process.env.EMAIL_USER,
          to: process.env.COMMAND_CENTER_EMAIL,
          subject: `🚨 EMERGENCY DISPATCH - ${incident.type}`,
          html: this.formatCommandCenterAlert(incident)
        });
      }

      console.log('📡 Command center alerted');
    } catch (error) {
      console.error('❌ Failed to send command center alert:', error.message);
    }
  }

  // Monitor response progress
  static monitorResponse(incident) {
    const checkInterval = 30000; // 30 seconds
    const maxWaitTime = 20 * 60 * 1000; // 20 minutes
    const startTime = Date.now();

    const monitor = setInterval(async () => {
      try {
        // Check if maximum wait time exceeded
        if (Date.now() - startTime > maxWaitTime) {
          console.warn(`⚠️  Response timeout for incident ${incident.id}`);
          await this.escalateIncident(incident);
          clearInterval(monitor);
          return;
        }

        // Check response status
        const currentIncident = await this.getIncident(incident.id);
        if (currentIncident?.status === 'RESOLVED' || currentIncident?.status === 'CANCELLED') {
          console.log(`✅ Incident ${incident.id} resolved, stopping monitoring`);
          clearInterval(monitor);
          return;
        }

        // Check if responders have arrived
        const arrivedCount = currentIncident?.assignments?.filter(a => a.status === 'ARRIVED').length || 0;
        if (arrivedCount > 0) {
          console.log(`👮 ${arrivedCount} responders arrived at incident ${incident.id}`);
        }

      } catch (error) {
        console.error('❌ Error monitoring response:', error.message);
      }
    }, checkInterval);
  }

  // Helper functions
  static generateIncidentId() {
    return `INC-${Date.now()}-${Math.random().toString(36).substr(2, 4).toUpperCase()}`;
  }

  static validateIncident(incident) {
    return incident && 
           incident.type && 
           EMERGENCY_TYPES[incident.type] &&
           incident.location &&
           incident.location.lat &&
           incident.location.lng;
  }

  static async storeIncident(incident) {
    if (firebase.db) {
      await firebase.db.ref(`incidents/${incident.id}`).set(incident);
    }
  }

  static async updateIncident(incident) {
    if (firebase.db) {
      await firebase.db.ref(`incidents/${incident.id}`).update(incident);
    }
  }

  static async getIncident(incidentId) {
    if (firebase.db) {
      const snapshot = await firebase.db.ref(`incidents/${incidentId}`).once('value');
      return snapshot.val();
    }
    return null;
  }

  static async updateResponderStatus(responderId, status, incidentId = null) {
    if (firebase.db) {
      const updates = {
        status,
        lastUpdated: new Date().toISOString()
      };
      if (incidentId) updates.currentIncident = incidentId;
      
      await firebase.db.ref(`responders/${responderId}`).update(updates);
    }
  }

  static async escalateIncident(incident) {
    console.log(`🚨 ESCALATING INCIDENT: ${incident.id}`);
    
    // Notify higher authorities
    const escalation = {
      incidentId: incident.id,
      escalatedAt: new Date().toISOString(),
      reason: 'Response timeout or no available responders',
      originalIncident: incident
    };

    await firebase.db?.ref('escalations').push(escalation);
  }

  static getMockResponders(count) {
    const mockResponders = [
      {
        id: 'resp_001',
        name: 'Security Team Alpha',
        skills: ['security', 'crowd_control'],
        location: { lat: 40.7128, lng: -74.0060 },
        phone: '+1234567890',
        email: 'security@venue.com',
        status: 'available'
      },
      {
        id: 'resp_002', 
        name: 'Medical Team 1',
        skills: ['paramedic', 'medical'],
        location: { lat: 40.7130, lng: -74.0058 },
        phone: '+1234567891',
        email: 'medical@venue.com',
        status: 'available'
      },
      {
        id: 'resp_003',
        name: 'Fire Safety Team',
        skills: ['fire_safety', 'evacuation_coordinator'],
        location: { lat: 40.7125, lng: -74.0065 },
        phone: '+1234567892',
        email: 'fire@venue.com',
        status: 'available'
      }
    ];

    return mockResponders.slice(0, count);
  }

  static formatResponderMessage(responder, incident, route) {
    return `🚨 EMERGENCY DISPATCH
Type: ${incident.type}
Location: ${incident.location?.description || 'Unknown'}
Priority: ${incident.priority}
ETA: ${route?.duration || 'Unknown'}
Incident ID: ${incident.id}

Report to location immediately.`;
  }

  static formatResponderEmailAlert(responder, incident, route) {
    return `
      <h2>🚨 EMERGENCY DISPATCH</h2>
      <p><strong>Responder:</strong> ${responder.name}</p>
      <p><strong>Incident Type:</strong> ${incident.type}</p>
      <p><strong>Priority:</strong> ${incident.priority}</p>
      <p><strong>Location:</strong> ${incident.location?.description || 'Unknown'}</p>
      <p><strong>Estimated Travel Time:</strong> ${route?.duration || 'Unknown'}</p>
      <p><strong>Incident ID:</strong> ${incident.id}</p>
      
      <h3>Route Instructions:</h3>
      <ul>
        ${route?.steps?.map(step => `<li>${step}</li>`).join('') || '<li>Navigate to incident location</li>'}
      </ul>
      
      <p><strong>Report to location immediately.</strong></p>
    `;
  }

  static formatCommandCenterAlert(incident) {
    return `
      <h2>🚨 EMERGENCY DISPATCH INITIATED</h2>
      <p><strong>Incident ID:</strong> ${incident.id}</p>
      <p><strong>Type:</strong> ${incident.type}</p>
      <p><strong>Priority:</strong> ${incident.priority}</p>
      <p><strong>Location:</strong> ${incident.location?.description || 'Unknown'}</p>
      <p><strong>Reported By:</strong> ${incident.reportedBy}</p>
      <p><strong>Time:</strong> ${new Date(incident.timestamp).toLocaleString()}</p>
      
      <h3>Assigned Responders:</h3>
      <ul>
        ${incident.assignments?.map(a => `<li>${a.responderName} - ETA: ${a.estimatedArrival}</li>`).join('') || '<li>No responders assigned</li>'}
      </ul>
      
      <p><strong>Status:</strong> ${incident.status}</p>
    `;
  }
}

// Initialize dispatch services
initializeDispatchServices();

module.exports = {
  EmergencyDispatchSystem,
  EMERGENCY_TYPES,
  initializeDispatchServices
}; 