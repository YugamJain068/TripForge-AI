import { GoogleGenerativeAI } from "@google/generative-ai";
import connectDb from "@/db/connectDb";
import Trip from "@/db/models/Trip";
import axios from 'axios';
import { fetchUnsplashImage } from '@/lib/fetchUnsplashImage';

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

async function trackUnsplashDownload(downloadLocation) {
  if (!downloadLocation) return;

  try {
    await axios.get(downloadLocation, {
      headers: {
        Authorization: `Client-ID ${process.env.UNSPLASH_SECRET_KEY}`,
      },
    });
  } catch (err) {
    console.error("Error tracking Unsplash download:", err.message || err);
  }
}


const cleanAndParseJSON = (rawString) => {
  try {
    const cleaned = rawString
      .replace(/^```json\n?/, '')
      .replace(/```$/, '')
      .trim();

    const lastBraceIndex = cleaned.lastIndexOf('}');
    if (lastBraceIndex !== -1) {
      const jsonString = cleaned.substring(0, lastBraceIndex + 1);
      return JSON.parse(jsonString);
    }

    throw new Error("No valid closing brace in JSON string");
  } catch (err) {
    console.error('Error parsing JSON:', err);
    return null;
  }
};

function validateItinerary(parsedItinerary, expectedDays, departure) {
  const errors = [];

  // 1. JSON Structure Check
  if (
    !parsedItinerary ||
    !parsedItinerary.cities ||
    !parsedItinerary.travelling ||
    !Array.isArray(parsedItinerary.cities) ||
    !Array.isArray(parsedItinerary.travelling)
  ) {
    errors.push("Itinerary structure is invalid.");
    return { valid: false, errors };
  }

  const cities = parsedItinerary.cities.map(c => c.name);
  const travellingCities = new Set([
    ...parsedItinerary.travelling.map(t => t.to),
    ...parsedItinerary.travelling.map(t => t.from)
  ]);

  // 2. Check all travelling cities are in cities array
  for (const city of travellingCities) {
    if (city === departure) continue; // Skip validating the departure city
    if (!cities.includes(city)) {
      errors.push(`City "${city}" in 'travelling' is missing from 'cities' array.`);
    }
  }


  // 3. Validate exact number of trip days from all activity days
  // let activityDayCount = 0;
  // for (const city of parsedItinerary.cities) {
  //   if (!Array.isArray(city.activities)) continue;
  //   for (const day of city.activities) {
  //     activityDayCount++;
  //   }
  // }

  // if (activityDayCount !== expectedDays) {
  //   errors.push(
  //     `Mismatch in total days: expected ${expectedDays}, but found ${activityDayCount} activity days.`
  //   );
  // }

  // 4. Validate transportFromPrevious: first activity null, rest must not be
  for (const city of parsedItinerary.cities) {
    for (const day of city.activities || []) {
      const plans = day.plan || [];
      plans.forEach((activity, index) => {
        const tfp = activity.transportFromPrevious;
        if (index === 0 && tfp !== null) {
          errors.push(
            `Day ${day.day} in "${city.name}": First activity must have transportFromPrevious as null.`
          );
        }
        if (index > 0 && (!tfp || tfp === null)) {
          errors.push(
            `Day ${day.day} in "${city.name}": Activity #${index + 1} must have valid transportFromPrevious.`
          );
        }
      });
    }
  }

  return {
    valid: errors.length === 0,
    errors
  };
}

async function generateAndValidateItinerary(prompt, expectedDays, departure, maxRetries = 3) {
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    const model = genAI.getGenerativeModel({ model: "models/gemini-2.5-flash-lite" });
    const result = await model.generateContent(prompt);
    const response = result.response;
    const text = await response.text();

    let parsedItinerary;
    try {
      parsedItinerary = cleanAndParseJSON(text);
    } catch (e) {
      console.warn(`JSON parsing failed on attempt ${attempt}:`, e.message);
      if (attempt === maxRetries) throw new Error("Failed to parse valid JSON from Gemini.");
      continue; // try again
    }

    const { valid, errors } = validateItinerary(parsedItinerary, expectedDays, departure);
    if (valid) {
      return parsedItinerary;
    } else {
      console.warn(`Validation failed on attempt ${attempt}:`, errors);
      if (attempt === maxRetries) {
        throw new Error("Itinerary failed validation: " + errors.join("; "));
      }
    }
  }
}






export async function POST(req) {
  const budgetMap = {
    low: "₹0 – ₹2,00,000",
    medium: "₹2,00,000 – ₹5,00,000",
    high: "₹5,00,000+"
  };


  try {
    await connectDb();
    const formData = await req.json();
    const readableBudget = budgetMap[formData.selected_budget];
    const userPrompt = `
You are a professional AI travel planner.

Create a detailed, multi-city travel itinerary in **EXACTLY** the following JSON format. The itinerary is for "${formData.selected_member}" traveler(s), going on a ${formData.days}-day trip, starting from "${formData.departure}" and visiting: ${formData.destination}. The start date is ${formData.date} and end date should be automatically calculated based on trip length (${formData.days} days). Their interests include: ${formData.selectedActivities.join(", ")}. The budget is "${readableBudget}".

If you break ANY rule below, the entire output is INVALID and will be discarded. This itinerary will be machine-validated.

IMPORTANT RULES (you MUST follow all of these):
1. ONLY return valid **minified JSON**. Do NOT include markdown, comments, explanations, or formatting. No line breaks or extra content.
2. Wrap everything in a top-level JSON object matching the format below.
3. Use double quotes for all keys and string values. Use **null** (without quotes) where applicable.
4. ⚠️ You MUST return **EXACTLY ${formData.days} activity days** across all cities. NO MORE, NO LESS. 
   - If you return fewer or more days, the response is INVALID.
   - Total activity days = total number of objects in all cities[].activities[]
   - Every day must contain at least 1 plan item.
5. All cities in the "travelling" array MUST also appear in the "cities" array.
6. Use sequential day numbering across all cities: e.g., City A = Days 1–3, City B = Days 4–6.
7. Activities must be chronologically accurate — no time overlaps. Every day must start with a 'transportFromPrevious: null'.
8. For additional plans on the same day, each one must include a valid 'transportFromPrevious' object.
9. Valid transportFromPrevious.mode values (within cities): "Walk", "Car", "Metro", "Bus", "Bike", "Taxi"
10. Valid travelling.modeOfTransport values (between cities): "Flight", "Train", "Bus", "Car"
11. If travelling.modeOfTransport is "Flight", you MUST include valid "departure_airport_city_IATAcode" and "destination_airport_city_IATAcode". If not a flight, both should be null (not string "null").
12. Provide realistic durations for all transport entries (e.g., "10 mins", "45 mins")
13. Do not include any trailing commas or extra content.
14. Provide the 'notes' field for activites,hotels and travelling
15. ⚠️ You MUST provide valid geolocation coordinates for each activity using a "location" object with lat and lng (numbers only, not strings).
16. ⚠️ You MUST provide valid "coordinates" for each city using a "coordinates" object with lat and lng (numbers only, not strings). These represent the city center and will be used to center maps.


"${formData.departure}" is the starting point — only include it in the "cities" array if it's also one of the visit destinations.

JSON FORMAT TO FOLLOW EXACTLY (must be minified in output):

{
  "tripName": "Trip Title",
  "startDate": "${formData.date}",
  "endDate": "AUTO_CALCULATE_BASED_ON_STARTDATE_AND_DAYS",
  "cities": [
    {
      "name": "City Name",
      "coordinates": {
        "lat": 48.8566,
        "lng": 2.3522
      },
      "startDate": "YYYY-MM-DD",
      "endDate": "YYYY-MM-DD",
      "activities": [
        {
          "day": 1,
          "plan": [
            {
              "name": "Activity Title",
              "location": {
                "name": "Location Name",
                "lat": 48.8584,
                "lng": 2.2945
              },
              
              "time": "10:00 AM",
              "transportFromPrevious": null,
              "notes":"Activity related notes"
            },
            {
              "name": "Next Activity",
              "location": {
                "name": "Location Name",
                "lat": 48.8584,
                "lng": 2.2945
              },
              "time": "1:00 PM",
              "transportFromPrevious": {
                "mode": "Taxi",
                "from": "Previous Location",
                "to": "Next Location",
                "duration": "15 mins"
              },
              "notes":"Activity related notes"
            }
          ]
        }
      ],
      "notes": "Hotel area suggestions or city-specific tips"
    }
  ],
  "hotels": [
    {
      "city": "City Name",
      "cityCode": "cityCode",
      "checkIn": "YYYY-MM-DD",
      "checkOut": "YYYY-MM-DD",
      "notes": "Suggestions based on a ${readableBudget} budget"
    }
  ],
  "travelling": [
    {
      "from": "${formData.departure}",
      "to": "City A",
      "date": "YYYY-MM-DD",
      "modeOfTransport": "Flight",
      "departure_airport_city_IATAcode": "DEL",
      "destination_airport_city_IATAcode": "SYD",
      "notes": "Tips for this leg"
    },
    {
      "from": "City A",
      "to": "City B",
      "date": "YYYY-MM-DD",
      "modeOfTransport": "Bus",
      "departure_airport_city_IATAcode": null,
      "destination_airport_city_IATAcode": null,
      "notes": "Tips for this leg"
    }
  ]
}
`.trim();


    const parsedItinerary = await generateAndValidateItinerary(userPrompt, formData.days, formData.departure);

    const bannerImage = await fetchUnsplashImage(formData.destination);
    await trackUnsplashDownload(bannerImage.download_location);

    const newTrip = await Trip.create({
      userId: formData.userID,
      title: parsedItinerary.tripName,
      bannerImageUrl: bannerImage.url,
      bannerPhotographerName: bannerImage.photographerName,
      bannerPhotographerProfile: bannerImage.photographerProfile,
      adults: formData.adults,
      children: formData.children,
      infants: formData.infants,
      startDate: parsedItinerary.startDate,
      endDate: parsedItinerary.endDate,
      budget: formData.selected_budget,
      travelerType: formData.selected_member,
      cities: parsedItinerary.cities,
      hotels: parsedItinerary.hotels,
      travelling: parsedItinerary.travelling
    });




    return new Response(JSON.stringify({
      itinerary: JSON.parse(JSON.stringify(newTrip))
    }), {
      status: 200,
      headers: { "Content-Type": "application/json" }
    });

  } catch (error) {
    console.error("Gemini error:", error);
    return new Response(JSON.stringify({ error: "Failed to generate itinerary" }), {
      status: 500,
      headers: { "Content-Type": "application/json" }
    });
  }
}
