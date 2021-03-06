'use strict';

const Log = require('../utils/logger');
const TAG = 'osrm';
const request = require('request-promise');
const config = require('../../server').config;
const protocol = 'https';
const domain = 'api.mapbox.com';
const version = 'v5/mapbox';

exports.findRoute = async function (options) {
    let waypoints = options.waypoints;
    let coordinates = toOsrmFormat(waypoints);

    const service = 'directions';
    const profile = 'cycling';
    const query = 'continue_straight=true&geometries=geojson&overview=full&steps=false&access_token=' + config.mapbox_token;

    let requestString = protocol + '://' + domain + '/' + service + '/' + version + '/' + profile + '/';
    Log.debug(TAG, 'OSRM request path: ' + requestString);

    requestString += coordinates;
    requestString += '?' + query;

    let body = await request(requestString)
        .catch((error) => {
            if (error) {
                Log.error(TAG, 'OSRM request could not be satisfied', error);
            }
        });

    try {
        let bodyString = JSON.stringify(body).replace(/\\/g, '');
        bodyString = bodyString.substring(1, bodyString.length - 1);
        body = JSON.parse(bodyString);
    } catch (e) {
        Log.error(TAG, 'OSRM request could not be satisfied', body);
        return false;
    }

    let result = {
        distance: 0,
        waypoints: []
    };

    if (!resultOk(body)) {
        return;
    }

    const route = body.routes[0];
    const geo = route.geometry;
    const legs = route.legs;
    result.distance = route.distance;

    // Extract the geometry
    const coords = geo.coordinates;
    coords.forEach(function (location) {
        result.waypoints.push(location);
    });

    // Detect U Turns
    for (let leg of legs) {
        const steps = leg.steps;
        steps.forEach(function (step) {
            let maneuver = step.maneuver;
            if (maneuver && maneuver.modifier) {
                if (maneuver.modifier === 'uturn') {
                    Log.debug(TAG, 'UTURN DETECTED', maneuver);
                }
            }
        });
    }
    return new Promise((resolve) => {
        resolve(result);
    });
};

const toOsrmFormat = function (locations) {
    let coords = '';
    for (let location of locations) {
        coords += location.coordinates[0];
        coords += ',';
        coords += location.coordinates[1];
        coords += ';';
    }
    if (coords.length > 0) {
        coords = coords.substring(0, coords.length - 1);
    }
    return coords;
};

const resultOk = function (body) {
    if (!body) {
        Log.error(TAG, 'OSRM request did not return a body object');
        return false;
    }
    if (body.code !== 'Ok') {
        Log.error(TAG, 'OSRM response code was not Ok: ' + body.code);
        return false;
    }
    if (!body.routes) {
        Log.error(TAG, 'OSRM request did not return any routes');
        return false;
    }
    if (body.routes.length === 0) {
        Log.error(TAG, 'OSRM request did not return any routes');
        return false;
    }
    if (!body.routes[0].legs) {
        Log.error(TAG, 'OSRM request did not return any route legs');
        return false;
    }
    if (body.routes[0].legs.length === 0) {
        Log.error(TAG, 'OSRM request did not return any route legs');
        return false;
    }
    return true;
};
