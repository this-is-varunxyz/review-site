require('dotenv').config();
const express = require('express');
const { google } = require('googleapis');
const path = require('path');
const cors = require('cors');

const app = express();

// Google Services Setup
const auth = new google.auth.GoogleAuth({
  credentials: JSON.parse(process.env.GOOGLE_SHEETS_KEY),
  scopes: ['https://www.googleapis.com/auth/spreadsheets'],
});
const sheets = google.sheets({ version: 'v4', auth });

// Configuration
const CONFIG = {
  SPREADSHEET_ID: process.env.SPREADSHEET_ID || '',
  REVIEWS_SHEET: process.env.REVIEWS_SHEET || 'Reviews',
  FACULTY_SHEET: process.env.FACULTY_SHEET || 'Faculty',
  CACHE_DURATION: 5 * 60 * 1000 // 5 minutes cache
};

// Validate configuration
if (!CONFIG.SPREADSHEET_ID) {
  console.error('Missing required SPREADSHEET_ID. Please check your .env file');
  process.exit(1);
}

// In-memory cache for faculty data
let facultyCache = {
  data: null,
  timestamp: 0
};

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static('public'));

// Helper function to get all faculty data from Google Sheets
async function getFacultyDataFromSheets() {
  try {
    // Check cache first
    if (facultyCache.data && (Date.now() - facultyCache.timestamp) < CONFIG.CACHE_DURATION) {
      return facultyCache.data;
    }

    const res = await sheets.spreadsheets.values.get({
      spreadsheetId: CONFIG.SPREADSHEET_ID,
      range: `${CONFIG.FACULTY_SHEET}!A2:D`,
    });

    const rows = res.data.values || [];
    const facultyData = rows.map((row, index) => ({
      id: index + 1,
      name: row[0] || '',
      department: row[1] || '',
      subject: row[2] || '',
      mobile: row[3] || ''
    })).filter(faculty => faculty.name.trim() !== '');

    // Update cache
    facultyCache = {
      data: facultyData,
      timestamp: Date.now()
    };

    return facultyData;
  } catch (error) {
    console.error('Error fetching faculty data from sheets:', error);
    return await getFacultyFromReviews();
  }
}

// Fallback: Extract faculty names from existing reviews
async function getFacultyFromReviews() {
  try {
    const res = await sheets.spreadsheets.values.get({
      spreadsheetId: CONFIG.SPREADSHEET_ID,
      range: `${CONFIG.REVIEWS_SHEET}!A2:A`,
    });

    const rows = res.data.values || [];
    const uniqueNames = [...new Set(rows.map(row => row[0]).filter(name => name))];
    
    return uniqueNames.map((name, index) => ({
      id: index + 1,
      name: name,
      department: 'Not specified',
      subject: 'Not specified',
      mobile: 'Not available'
    }));
  } catch (error) {
    console.error('Error extracting faculty from reviews:', error);
    return [];
  }
}

// Helper function to calculate all faculty averages
async function getFacultyAverages(facultyName) {
  try {
    const res = await sheets.spreadsheets.values.get({
      spreadsheetId: CONFIG.SPREADSHEET_ID,
      range: `${CONFIG.REVIEWS_SHEET}!A2:I`,
    });

    const rows = res.data.values || [];
    
    // Normalize faculty name for comparison
    const normalizedFacultyName = facultyName.toLowerCase().trim();
    
    const facultyReviews = rows.filter(row => 
      row[0] && row[0].toLowerCase().trim() === normalizedFacultyName
    );

    if (facultyReviews.length === 0) return null;

    // Calculate averages for all categories
    const calculateAverage = (index) => {
      const validReviews = facultyReviews.filter(row => row[index] && !isNaN(row[index]));
      if (validReviews.length === 0) return 0;
      const sum = validReviews.reduce((sum, row) => sum + parseFloat(row[index]), 0);
      return (sum / validReviews.length).toFixed(1);
    };

    return {
      teaching: calculateAverage(1),
      evaluation: calculateAverage(2),
      behaviour: calculateAverage(3),
      internals: calculateAverage(4),
      classAverage: calculateAverage(5),
      overall: calculateAverage(6),
      count: facultyReviews.length,
      latestReview: facultyReviews[0]
    };
  } catch (error) {
    console.error('Error calculating faculty averages:', error);
    return null;
  }
}

// Helper function to search faculty by partial name match
function searchFaculty(facultyData, searchTerm) {
  const term = searchTerm.toLowerCase().trim();
  return facultyData.filter(faculty => 
    faculty.name.toLowerCase().includes(term) ||
    faculty.department.toLowerCase().includes(term) ||
    faculty.subject.toLowerCase().includes(term)
  );
}

// API endpoint to submit a new review
app.post('/api/submit-review', async (req, res) => {
  try {
    const {
      name: facultyName,
      teaching,
      evaluation,
      behaviour,
      internals,
      classAverage,
      overall
    } = req.body;

    // Input validation
    if (!facultyName || isNaN(teaching) || isNaN(evaluation) || 
        isNaN(behaviour) || isNaN(internals) || isNaN(classAverage) || 
        isNaN(overall)) {
      return res.status(400).json({ 
        success: false,
        error: 'Invalid input data',
        message: 'All fields are required and ratings must be numbers'
      });
    }

    // Validate rating ranges (assuming 1-5 scale)
    const ratings = [teaching, evaluation, behaviour, internals, overall];
    const invalidRatings = ratings.some(rating => rating < 1 || rating > 5);
    
    if (invalidRatings) {
      return res.status(400).json({
        success: false,
        error: 'Invalid rating range',
        message: 'All ratings must be between 1 and 5'
      });
    }

    // Normalize faculty name (trim and standardize)
    const normalizedFacultyName = facultyName.trim();

    const reviewData = [
      normalizedFacultyName,
      parseInt(teaching),
      parseInt(evaluation),
      parseInt(behaviour),
      parseInt(internals),
      parseFloat(classAverage),
      parseInt(overall),
      new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' })
    ];

    // Append to Google Sheets
    const response = await sheets.spreadsheets.values.append({
      spreadsheetId: CONFIG.SPREADSHEET_ID,
      range: `${CONFIG.REVIEWS_SHEET}!A2:H`,
      valueInputOption: 'USER_ENTERED',
      insertDataOption: 'INSERT_ROWS',
      requestBody: {
        values: [reviewData]
      }
    });

    // Clear faculty cache to refresh data
    facultyCache.timestamp = 0;

    res.json({ 
      success: true, 
      message: 'Review submitted successfully',
      data: {
        faculty: reviewData[0],
        ratings: {
          teaching: reviewData[1],
          evaluation: reviewData[2],
          behaviour: reviewData[3],
          internals: reviewData[4],
          classAverage: reviewData[5],
          overall: reviewData[6]
        },
        timestamp: reviewData[7]
      }
    });

  } catch (error) {
    console.error('Error submitting review:', error);
    res.status(500).json({ 
      success: false,
      error: 'Failed to submit review',
      details: error.message 
    });
  }
});

// Other API endpoints remain the same...

// Start Server
const PORT = process.env.REVIEW_PORT || 3001;
app.listen(PORT, () => {
  console.log(`🌐 Faculty Review API running on port ${PORT}`);
  console.log(`📊 Using spreadsheet: ${CONFIG.SPREADSHEET_ID}`);
  console.log(`📝 Reviews sheet: ${CONFIG.REVIEWS_SHEET}`);
  console.log(`👥 Faculty sheet: ${CONFIG.FACULTY_SHEET}`);
  console.log(`🔄 Cache duration: ${CONFIG.CACHE_DURATION / 1000}s`);
  
  // Initial faculty data load
  getFacultyDataFromSheets()
    .then(data => console.log(`✅ Loaded ${data.length} faculty members`))
    .catch(err => console.log(`⚠️  Faculty data will be loaded on first request: ${err.message}`));
});