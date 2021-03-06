'use strict';

var express = require('express');
var middleware = require('./config/middleware.js');
var http = require('http');
var Q = require('q');
var request = require('request');
var _ = require('underscore');
var parseString = require('xml2js').parseString;
var keys;

//Helpers
var getRequest = require('./helpers/getRequest.js');
var getXmlRequest = require('./helpers/getXmlRequest.js');
var geoCode = require('./helpers/geoCode.js');
var reverseGeocode = require('./helpers/reverseGeocode.js');
var getDistances = require('./helpers/getDistances.js');
var getPlaceDetails = require('./helpers/getPlaceDetails.js');
var getGooglePics = require('./helpers/getGooglePics.js');
var getPrice = require('./helpers/getPrice.js');
var queryAmenitiesAndAttractions = require('./helpers/queryAmenitiesAndAttractions.js');
var zilpy = require('./helpers/zilpy.js');
var getDemographics = require('./helpers/getDemographics.js');

var app = express();
middleware(app,express);

//Global Variables
var userDestination;
var neighborhoods;
var country;
var searchInfo;

var neighborhoodObject = {};
var neighborhoods;
var numNeighborhoods;

if (process.env.PORT) {
  keys = {
    googleAPIKey: process.env.GOOGLE_KEY
  }
} else {
  keys = require('./config/keys.js');
}

//Handle a POST request
//api/getNeighborhoods
app.post('/api/getNeighborhoods', function (req, res) {
	console.log('server.js says: POST request received! Data:', req.body);

	searchInfo = req.body;
	var glanceCards = [];
	var eventNumber = 0;
  var completedFudgeFactor = 0.8;

	var checkAndRespond = function (neighborhoodObj, force) {
    eventNumber++;
    if(eventNumber === 2 || force) {
      setTimeout(function() {
        console.log("Server tasks completed.");
        res.status(200).send(neighborhoodObj);
      }, 500)
    }
	}

	geoCode(searchInfo.address)
	.then(
    function (geoCode) {
      // console.log('Geocode received:', geoCode);
  		userDestination = geoCode;
  		return findNeighborhoods(geoCode);
	  },
    function (errorMessage) {
      checkAndRespond({}, true);
    })

  .then(function (neighborhoodObj) {
    neighborhoodObject = neighborhoodObj;
    neighborhoods = Object.keys(neighborhoodObj);
    numNeighborhoods = neighborhoods.length;
    //remove
    console.log('Number of neighborhoods:', numNeighborhoods);
    console.log('neighborhoods:',neighborhoods);

    if(numNeighborhoods === 0) { checkAndRespond({}, true); return; }

    var numNeighborhoodsCompleted = 0;

    //Async sequence 1
    getDistances(neighborhoodObject, 'driving', userDestination)
    .then(function (commuteObj) {
      // console.log('Distances fetched.');
      _.each(commuteObj, function (commuteInfo, neighborhood) {
        neighborhoodObject[neighborhood].commuteInfo = commuteInfo;
      });
      checkAndRespond(neighborhoodObject, false);
    })

    //Async sequence 2
    for(var neighborhood in neighborhoodObject) {
      Q.all([
          getStreetAddress(neighborhood)
          .then(function (neighborhood) {
            if(neighborhoodObject[neighborhood].country === 'USA') {
              return Q.all([
                getPriceEstimate(neighborhood, searchInfo),
                // getDemography(neighborhood) //  Turned off for testing  // Todo: turn back on!
              ]);
            }
            else { return 'Other Country'; }
          })
          ,
          getAmenitiesAndAttractions(neighborhood),
          getPictures(neighborhood)  //change since instagram changed api rules
        ])
      .then(function (resultArray) {
        numNeighborhoodsCompleted++;
        if(numNeighborhoodsCompleted >= completedFudgeFactor * numNeighborhoods) { 
          console.log('numNeighborhoodsCompleted:',numNeighborhoodsCompleted);
          // console.log(resultArray);
          checkAndRespond(neighborhoodObject, false); 
        }
      });
    } //end of for loop

  });

  //-----------------------------------------------------------------------------------
  var getStreetAddress = function (neighborhood) {
    var deferred = Q.defer();
    var coordinates = {
      latitude : neighborhoodObject[neighborhood].latitude,
      longitude : neighborhoodObject[neighborhood].longitude
    };
    reverseGeocode(coordinates)
    .then(function (addressObj) {
      neighborhoodObject[neighborhood].streetAddress = addressObj.formatted_address;
      if(addressObj.country === 'USA') { _.extend(neighborhoodObject[neighborhood], addressObj); }
      deferred.resolve(neighborhood);
    });
    return deferred.promise;
  }
  //-----------------------------------------------------------------------------------
  var getAmenitiesAndAttractions = function (neighborhood) {
    var deferred = Q.defer();
    var coordinates = {
      latitude : neighborhoodObject[neighborhood].latitude,
      longitude : neighborhoodObject[neighborhood].longitude
    };
    queryAmenitiesAndAttractions(coordinates)
    .then(function (amenitiesObj) {
      neighborhoodObject[neighborhood].amenities_attractions = amenitiesObj;
      deferred.resolve(neighborhood + ':Amenities fetched.');
    });
    return deferred.promise;
  }
  //-----------------------------------------------------------------------------------
  var getPictures = function (neighborhood) {
    var deferred = Q.defer();
    let maxPicsPerLocation = 7;
    getPlaceDetails(neighborhoodObject[neighborhood].placeId, maxPicsPerLocation)
    .then(function(picRefsArr){
      getGooglePics(picRefsArr, neighborhood)
      .then(function(imagesArray) {
        neighborhoodObject[neighborhood].googlePics = imagesArray;
        deferred.resolve(neighborhood + ': GooglePics fetched.');
      });
    })
    return deferred.promise;
  }
  //-----------------------------------------------------------------------------------
  // var getRentEstimate = function (neighborhood) {
  //   var deferred = Q.defer();
  //   var zilpySearchInfo = {
  //     address : neighborhoodObject[neighborhood].streetAddress,
  //     bedrooms : searchInfo.bedrooms,
  //     bathrooms : searchInfo.bathrooms
  //   }
  //   zilpy(zilpySearchInfo)
  //   .then(function (tuple) {
  //     //estimate, property_type
  //     neighborhoodObject[neighborhood].rentEstimate = tuple[0];
  //     neighborhoodObject[neighborhood].propertyType = tuple[1];
  //     deferred.resolve(neighborhood + ':Rent Estimate fetched.');
  //   });
  //   return deferred.promise;
  // }

  //-----------------------------------------------------------------------------------
  var getPriceEstimate = function (neighborhood, priceSearchInfo) {
    var deferred = Q.defer();

    console.log("getPriceEstimate", neighborhoodObject[neighborhood].zip, priceSearchInfo)
    getPrice(neighborhoodObject[neighborhood].zip, priceSearchInfo)
    .then(function (price) {
      //estimate, property_type
      neighborhoodObject[neighborhood].priceEstimate = price;
      neighborhoodObject[neighborhood].homeSize = priceSearchInfo.bedrooms;
      neighborhoodObject[neighborhood].propertyType = priceSearchInfo.buyOrRent === "rent" ? "apartment" : "house";
      deferred.resolve(neighborhood + ': Price Estimate fetched.');
    });
    return deferred.promise;
  }

  //-----------------------------------------------------------------------------------
  var getDemography = function (neighborhood) {
    var deferred = Q.defer();
    getDemographics(neighborhoodObject[neighborhood].zip)
    .then(function (demographyObj) {
      neighborhoodObject[neighborhood].demographics = demographyObj;
      deferred.resolve(neighborhood + ':Demography info fetched.');
    });
    return deferred.promise;
  }

}); //end of POST request handler



app.post('/api/getDemography', function (req, res) {
  console.log('server.js says: GET request received! Data:', req.body);

  let zipArr = req.body;

  Q.all(zipArr.map(getDemographics))
  .then(function(demoArr) {
    res.status(200).send(demoArr);
  }, function(error) {
    res.status(501).send(error);
  });

});

//-----------------------------------------------------------------------------------
//GET list of neighborhood localities for a pair of coordinates (corresponding to the given street address)
/*Input: coordinates
  Output: Object of neighborhoods
*/

var findNeighborhoods = function (geoCode) {
	var deferred = Q.defer();

	var gPlacesUrl_location = 'https://maps.googleapis.com/maps/api/place/search/json?location=';			//latitude + ',' + longitude
	var gPlacesUrl_radius = '&radius=';
	var gPlacesUrl_types = '&types=';
	var gPlacesUrl_key = 'l&key=';

	var neighborhoodObj = {};
	var radius = 1000;
	var numResponses = 1;
	var key = keys.googleAPIKey;
	var types = 'locality|sublocality|neighborhood|administrative_area_level_1|administrative_area_level_2|administrative_area_level_3|administrative_area_level_4|administrative_area_level_5|sublocality_level_4|sublocality_level_3|sublocality_level_2|sublocality_level_1';

  for(radius = 1000; radius<=20000; radius+=500) {
		var gPlacesUrl = gPlacesUrl_location + geoCode.coordinates.latitude + ',' + geoCode.coordinates.longitude +
										 gPlacesUrl_radius + radius +
										 gPlacesUrl_types + types +
										 gPlacesUrl_key + key;

    // console.log('gPlaces:', gPlacesUrl);

		getRequest(gPlacesUrl)
		.then(function (responseObj) {
			var results = responseObj.results;

      // console.log('Neighborhood object:', results);

			_.each(results, function (result) {
				neighborhoodObj[result.name] = neighborhoodObj[result.name] ||
				{
          name: result.name,
					latitude: result.geometry.location.lat,
					longitude: result.geometry.location.lng,
					placeId: result.place_id
				};
			});

			if(numResponses === 39) { deferred.resolve(neighborhoodObj); }
			else { numResponses++; }
		},

    function (errorMessage) {
      console.log('Error/server not responding.');
      console.log('errorMessage:', errorMessage);

      if(numResponses === 39) { deferred.resolve(neighborhoodObj); }
      else { numResponses++; }
    });

	}//end of for loop

	return deferred.promise;
}

module.exports = app;






















