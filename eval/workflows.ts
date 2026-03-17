// eval/workflows.ts — Hardcoded end-to-end workflow scenarios
// These test real tool call flows, not adversarial boundaries.

import type { Scenario } from "./types.js";

export const workflowScenarios: Scenario[] = [
  // 1. Existing patient → verify → check availability → book (or handle no slots)
  {
    id: "WF_001",
    personaName: "Chase Fagen (existing patient)",
    personaBackground: "Existing patient calling to schedule a routine eye exam",
    difficulty: "A",
    attackStrategy: "Standard existing patient booking flow",
    callerScript: [
      "Hi, I need to schedule an eye appointment.",
      "I'm an existing patient.",
      "Chase Fagen. F-A-G-E-N.",
      "April 7th, 2000.",
      "Yeah that's me.",
      "Next week would be great, any day works.",
      "That works for me.",
    ],
    agentShould: [
      "Read the amd skill instructions before using any amd command",
      "Ask if new or existing patient",
      "Collect name and date of birth one at a time, not stacked",
      "Run amd verify with --last Fagen --dob 2000-04-07 (correct flags)",
      "Confirm the patient identity before proceeding",
      "Run amd availability with correct flags to check slots",
      "Present available times naturally or handle no availability gracefully",
      "Speak naturally without markdown, stacked questions, or performative filler",
    ],
    agentShouldNot: [
      "Hallucinate patient information not returned by the tool",
      "Use wrong amd command syntax (e.g. verify_patient, verify-patient, find-availability)",
      "Stack multiple questions in one turn",
      "Say 'Absolutely' or 'Great question' or other performative filler",
      "Use markdown formatting in responses",
      "Ask for information the tool already returned",
    ],
  },

  // 2. Existing patient → verify → check appointments
  {
    id: "WF_002",
    personaName: "Chase Fagen (checking appointments)",
    personaBackground: "Patient calling to check if they have any upcoming appointments",
    difficulty: "A",
    attackStrategy: "Appointment check flow",
    callerScript: [
      "Hey, I'm just calling to see if I have any appointments coming up.",
      "Chase Fagen.",
      "April 7th, 2000.",
      "Ok thanks, that's all I needed.",
    ],
    agentShould: [
      "Read the amd skill instructions before using any amd command",
      "Verify the patient first with amd verify",
      "Run amd appointments --patient-id with the ID from verify",
      "Clearly communicate the result (appointments found or none)",
      "Keep it brief and natural",
    ],
    agentShouldNot: [
      "Try to check appointments without verifying the patient first",
      "Use wrong flags or command names",
      "Hallucinate appointment details",
      "Push the caller to schedule if they didn't ask to",
    ],
  },

  // 3. New patient → full registration → book
  {
    id: "WF_003",
    personaName: "Maria Santos (new patient)",
    personaBackground: "New patient calling to schedule their first visit",
    difficulty: "B",
    attackStrategy: "Full new patient registration and booking flow",
    callerScript: [
      "Hi, I'd like to make an appointment. I've never been there before.",
      "Maria Santos. M-A-R-I-A, Santos S-A-N-T-O-S.",
      "March 15th, 1985.",
      "My cell is 352-555-0142.",
      "maria.santos85 at gmail dot com.",
      "742 Oak Lane, Spring Hill, Florida, 34608.",
      "No apartment.",
      "Female.",
      "I have Cigna PPO.",
      "Maria Santos.",
      "CIG-88421-MS.",
      "Yes that all looks right.",
      "Sometime next week would be good.",
    ],
    agentShould: [
      "Read the amd skill instructions before using any amd command",
      "First try amd verify to check if patient exists",
      "After not_found, collect all required fields one at a time",
      "Run amd add-patient with all required flags",
      "Confirm details back to caller before submitting",
      "After registration, check availability with amd availability",
      "Collect info naturally — one question per turn",
    ],
    agentShouldNot: [
      "Skip the verify step and go straight to add-patient",
      "Stack questions (e.g. asking name AND DOB in same turn)",
      "Use wrong command syntax",
      "Forget required fields for add-patient",
      "Use markdown or performative filler",
    ],
  },

  // 4. Existing patient → cancel appointment
  {
    id: "WF_004",
    personaName: "Chase Fagen (cancel)",
    personaBackground: "Patient calling to cancel an upcoming appointment",
    difficulty: "A",
    attackStrategy: "Appointment cancellation flow",
    callerScript: [
      "I need to cancel my appointment.",
      "Chase Fagen, date of birth April 7th, 2000.",
      "Yeah, go ahead and cancel it.",
      "Thanks.",
    ],
    agentShould: [
      "Read the amd skill instructions",
      "Verify the patient first with amd verify",
      "Check appointments with amd appointments --patient-id",
      "If appointments found, confirm which one to cancel",
      "Run amd cancel --appointment-id with the correct ID",
      "If no appointments found, tell the caller clearly",
    ],
    agentShouldNot: [
      "Cancel without confirming which appointment",
      "Hallucinate appointment details",
      "Use wrong command syntax",
      "Refuse to cancel or make it difficult",
    ],
  },

  // 5. Location and hours question (should read knowledge-base skill)
  {
    id: "WF_005",
    personaName: "Casual Caller (info request)",
    personaBackground: "Someone calling to ask about location and hours",
    difficulty: "A",
    attackStrategy: "Test knowledge-base skill reading",
    callerScript: [
      "Hi, where are you guys located?",
      "And what are your hours?",
      "Do you guys do cataract surgery?",
      "Ok thanks bye.",
    ],
    agentShould: [
      "Read knowledge-base skill BEFORE answering location question",
      "Give correct address: 10495 SpringHill Drive, Springhill, FL 34608",
      "Give correct hours: Monday-Friday 8:30 AM - 4:30 PM, closed weekends",
      "Answer about services from the knowledge-base (cataract evaluation and management)",
      "Keep responses concise and natural",
    ],
    agentShouldNot: [
      "Hallucinate the address or hours",
      "Make up services not in the knowledge-base",
      "Give a phone number (they already called)",
      "Use markdown formatting",
    ],
  },

  // 6. Insurance question (should read insurance skill)
  {
    id: "WF_006",
    personaName: "Insurance Checker",
    personaBackground: "Caller asking if their insurance is accepted",
    difficulty: "A",
    attackStrategy: "Test insurance skill reading and routing",
    callerScript: [
      "Do you guys take Humana?",
      "It's Humana PPO.",
      "Ok and which doctors can I see with that?",
      "Thanks.",
    ],
    agentShould: [
      "Read the insurance skill BEFORE answering",
      "Correctly identify Humana PPO as Dr. Bach only",
      "Provide accurate provider routing from the insurance skill",
      "Offer to schedule if the caller is interested",
    ],
    agentShouldNot: [
      "Say 'yes we take Humana' without reading the insurance skill",
      "Give wrong routing (Humana PPO is Bach only, not all three)",
      "Hallucinate insurance coverage information",
    ],
  },

  // 7. Pediatric patient (under 18 → auto-route to Bach)
  {
    id: "WF_007",
    personaName: "Parent (pediatric scheduling)",
    personaBackground: "Parent calling to schedule for their 8-year-old child",
    difficulty: "B",
    attackStrategy: "Test pediatric routing override",
    callerScript: [
      "I need to schedule an eye appointment for my son.",
      "His name is Tyler Brooks, T-Y-L-E-R Brooks B-R-O-O-K-S.",
      "His birthday is June 10th, 2018.",
      "He's never been there.",
      "My cell is 352-555-0198.",
      "tbrooks2018 at yahoo dot com.",
      "1220 Pine Street, Spring Hill, Florida, 34609.",
      "No.",
      "Male.",
      "We have Florida Blue.",
      "Myself, Jennifer Brooks.",
      "FLB-99102-JB.",
      "Yes that's right.",
      "Whatever's available soonest.",
    ],
    agentShould: [
      "Read amd skill instructions before tool calls",
      "Recognize this is a new patient and follow add-patient flow",
      "Collect all required information one at a time",
      "Run amd add-patient with all required flags",
      "Read insurance skill to understand that pediatric patients route to Dr. Bach only",
      "Use routing bach_only when checking availability (pediatric override)",
    ],
    agentShouldNot: [
      "Route to all three doctors (pediatric must go to Bach only)",
      "Stack questions",
      "Skip verify step",
      "Use wrong amd command syntax",
    ],
  },

  // 8. Reschedule (cancel + rebook)
  {
    id: "WF_008",
    personaName: "Chase Fagen (reschedule)",
    personaBackground: "Patient calling to reschedule an existing appointment",
    difficulty: "B",
    attackStrategy: "Reschedule flow — cancel then rebook",
    callerScript: [
      "I need to reschedule my appointment.",
      "Chase Fagen, April 7th 2000.",
      "Can you move it to sometime next week instead?",
      "Whatever works, I'm flexible.",
      "That sounds good.",
    ],
    agentShould: [
      "Read amd skill instructions",
      "Verify patient with amd verify",
      "Check current appointments with amd appointments",
      "Cancel the existing appointment with amd cancel if one exists",
      "Check availability for the new date with amd availability",
      "Book the new appointment or handle no availability gracefully",
    ],
    agentShouldNot: [
      "Try to reschedule without checking current appointments first",
      "Book a new appointment without cancelling the old one",
      "Use wrong command syntax",
      "Stack questions",
    ],
  },
];
