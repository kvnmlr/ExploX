'use strict';

const Log = require('../utils/logger');
const TAG = 'controllers/generate';
const mongoose = require('mongoose');
const Geo = mongoose.model('Geo');
const Route = mongoose.model('Route');
const CreatorResult = mongoose.model('CreatorResult');
const User = mongoose.model('User');
const users = require('./users');
const routes = require('./routes');
const osrm = require('./osrm');
const importExport = require('./importexport');
const geolib = require('geolib');

/**
 * Shuffles array in place.
 * @param {Array} a items An array containing the items.
 */
function shuffle (a) {
    let j, x, i;
    for (i = a.length - 1; i > 0; i--) {
        j = Math.floor(Math.random() * (i + 1));
        x = a[i];
        a[i] = a[j];
        a[j] = x;
    }
    return a;
}

function generateNodes (routes, isActivity, query) {
    let nodes = [];

    // add the original routes
    for (let route of routes) {
        let start, end;
        if (route.strava.start_latlng) {
            start = route.strava.start_latlng;
            end = route.strava.end_latlng;
        } else {
            start = [route.geo[0].location.coordinates[1], route.geo[0].location.coordinates[0]];
            end = [route.geo[route.geo.length - 1].location.coordinates[1], route.geo[route.geo.length - 1].location.coordinates[0]];
        }

        let startGeo = 'T0';
        let firstThird = 'T1';
        let secondThird = 'T2';
        let endGeo = 'T3';

        let partitions = [startGeo, /* firstThird, secondThird, */ endGeo];

        for (let i = 0; i < partitions.length - 1; ++i) {
            for (let j = i + 1; j < partitions.length; ++j) {
                const partitionStart = partitions[i];
                const partitionEnd = partitions[j];

                let node = {
                    name: route.title,
                    start: start,
                    end: end,
                    distance: route.distance,
                    lowerBoundDistance: route.lowerBoundDistance,
                    successors: [],
                    inv: null,
                    isActivity: isActivity,
                    isInv: false,
                    firstGeo: partitionStart,
                    lastGeo: partitionEnd,
                    id: route._id,
                    route: null,
                };
                let nodeInv = {
                    name: '(inv) ' + route.title,
                    start: start,
                    end: end,
                    distance: route.distance,
                    lowerBoundDistance: route.lowerBoundDistance,
                    successors: [],
                    inv: node.name,
                    isActivity: isActivity,
                    isInv: true,
                    firstGeo: partitionEnd,
                    lastGeo: partitionStart,
                    id: route._id,
                    route: null,
                };
                node.inv = nodeInv.name;
                nodes.push(node, nodeInv);
            }
        }
    }

    return nodes;
}

function connectNodes (start, end, nodes) {
    start.successors = [];
    nodes.forEach(function (node) {
        node.successors = [];
        start.successors.push({
            node: node,
            distance: geolib.getDistance(
                {latitude: start.end.lat, longitude: start.end.lng},
                {latitude: node.start[0], longitude: node.start[1]}
            )
        });

        node.successors.push({
            node: end,
            distance: geolib.getDistance(
                {latitude: node.end[0], longitude: node.end[1]},
                {latitude: end.start.lat, longitude: end.start.lng}
            )
        });
        nodes.forEach(function (innerLoopNode) {
            if (node.inv !== innerLoopNode.name) {
                node.successors.push({
                    node: innerLoopNode,
                    distance: geolib.getDistance(
                        {latitude: node.end[0], longitude: node.end[1]},
                        {latitude: innerLoopNode.start[0], longitude: innerLoopNode.start[1]}
                    )
                });
            }
        });
    });
}

function makeComboPaths (start, end, nodes, query, requireActivity) {
    let resultPaths = [];
    const distance = query.distance;
    const useParts = Math.floor(Math.min(Math.max(distance / 20000, 1), 3));  // 20: 2, 50: 3
    const minDepthOriginal = 2 + useParts;
    const stopAfter = 1;

    for (let i = 0; i < 10; ++i) {
        const minDepth = minDepthOriginal + (i % 3);
        const maxDepth = Math.min(Math.ceil(minDepth * 1.5), 6) + (i % 3);

        let localResultPaths = [];
        let pathList = [];
        pathList.push(start);

        // Log.debug(TAG, 'Starting DFS with parameters: minDepth = ' + minDepth + ', maxDepth = ' + maxDepth);
        printAllPathsUntil(start, end, pathList, 0, maxDepth, minDepth, distance, localResultPaths, stopAfter, requireActivity);
        resultPaths.push.apply(resultPaths, localResultPaths);
        start.successors.sort(function (a, b) {
            return b.node.lowerBoundDistance * (Math.random() * (1.1 - 0.9) + 0.9).toFixed(1)
                - a.node.lowerBoundDistance * (Math.random() * (1.1 - 0.9) + 0.9).toFixed(1);
        });
        start.isVisited = false;

        if (i % 3 === 2) {
            // rough sorting
            nodes.forEach(function (node) {
                node.isVisited = false;
                node.successors.sort(function (a, b) {
                    return b.node.lowerBoundDistance * (Math.random() * (1.1 - 0.9) + 0.9).toFixed(1)
                        - a.node.lowerBoundDistance * (Math.random() * (1.1 - 0.9) + 0.9).toFixed(1);
                });
            });
        }
    }

    // remove the duplicates
    let seen = [];
    resultPaths = resultPaths.filter((path) => {
        const okay = !seen.includes(path.distance);
        seen.push(path.distance);
        return okay;
    });
    return resultPaths;
}

function getDistanceFromLatLonInKm (lat1, lon1, lat2, lon2) {
    const R = 6371; // Radius of the earth in km
    let dLat = deg2rad(lat2 - lat1);  // deg2rad below
    let dLon = deg2rad(lon2 - lon1);
    let a =
        Math.sin(dLat / 2) * Math.sin(dLat / 2) +
        Math.cos(deg2rad(lat1)) * Math.cos(deg2rad(lat2)) *
        Math.sin(dLon / 2) * Math.sin(dLon / 2);
    let c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
    let d = R * c; // Distance in km
    return d;
}

function deg2rad (deg) {
    return deg * (Math.PI / 180);
}

function roughSizeOfObject (object) {
    const objectList = [];
    const stack = [object];
    let bytes = 0;

    while (stack.length) {
        const value = stack.pop();

        if (typeof value === 'boolean') {
            bytes += 4;
        }
        else if (typeof value === 'string') {
            bytes += value.length * 2;
        }
        else if (typeof value === 'number') {
            bytes += 8;
        }
        else if
        (
            typeof value === 'object'
            && objectList.indexOf(value) === -1
        ) {
            objectList.push(value);

            for (let i in value) {
                stack.push(value[i]);
            }
        }
    }
    return bytes;
}

/**
 * Generates a new route by doing the following calculations in sequence:
 *      1. Distance filter
 *      2. Lower Bound filer
 *      3. Combine routes and segments and sort by LB distance
 *      4. Let OSRM generate candidates
 *      5. Rank and filter candidates by familiarity
 *      6. Create and save the routes in the DB, deliver results to the user
 */
exports.generate = async function (req, res) {
    Log.log(TAG, 'Generate');
    let user = await User.load_full(req.user._id, {});
    let distance = parseFloat(req.body.distance) * 1000 || 5000;
    let query = {
        preference: req.body.preference || 'discover',
        duration: req.body.duration || 0,
        distance: distance,
        radius: distance / 2.0,
        difficulty: req.body.difficulty || 'advanced',
        start: req.body.start,
        end: req.body.end,
        request: req,
        response: res,
        user: user,
    };
    let result = {};

    result = await initSearch(query, result);
    result = await distanceFilter(query, result);
    result = await lowerBoundsFilter(query, result);
    result = await combine(query, result);
    result = await sortAndReduce(query, result);
    result = await populate(query, result);
    result = await generateCandidates(query, result);
    result = await familiarityFilter(query, result);
    result = await createRoutes(query, result);
    await respond(query, result);
};

const initSearch = function (query, result) {
    Log.debug(TAG, '');
    Log.log(TAG, '== Init search ==');
    result = {
        goodRoutes: [],
        goodSegments: [],
        explorativeCombos: [],
        familiarCombos: [],
        finalRoutes: [],
        candidates: [],
        familiarCandidates: [],
        resultRoutes: [],
        familiarityScores: [],
    };
    return result;
};

/**
 * Keep routes and segments that are shorter than the route distance.
 */
const distanceFilter = async function (query, result) {
    Log.debug(TAG, '');
    Log.log(TAG, '== Distance Filter ==');
    let criteria = {
        isRoute: true,
        isGenerated: false,
        distance: {
            $lt: query.distance,
            $gt: query.distance / 10   // this segment should be at least 20% of the final route (to avoid too small/insignificant segments
        },
        geo: {$exists: true, $not: {$size: 0}},
    };
    // get all routes that are shorter than the route should-distance
    const routes = await Route.list({criteria: criteria, detailed: false, limit: 50000, sort: {distance: 1}});
    result.goodRoutes = routes;

    // get all segments that are shorter than the route should-distance
    criteria.isRoute = false;
    const segments = await Route.list({criteria: criteria, detailed: false, limit: 50000, sort: {distance: 1}});
    result.goodSegments = segments;

    result.goodActivities = query.user.activities.filter((act) => {
        return act.distance < query.distance && act.distance > query.distance / 5;
    });

    Log.debug(TAG, routes.length + ' possible routes after distance filter: ', /* routes.map(r => r.distance + ' (' + r.title + ')') */);
    Log.debug(TAG, segments.length + ' possible segments after distance filter: ', /* segments.map(s => s.distance + ' (' + s.title + ')') */);
    Log.debug(TAG, result.goodActivities.length + ' possible own activities after distance filter: ', /* segments.map(s => s.distance + ' (' + s.title + ')') */);

    return result;
};

/**
 * Keep routes and segments where, when incorporating them into the route,
 * the lower bound on the total distance would still be less than the route distance.
 */
const lowerBoundsFilter = async function (query, result) {
    Log.debug(TAG, '');
    Log.log(TAG, '== Lower Bound Filter ==');

    let newGoodRoutes = [];
    let newGoodSegments = [];
    let newGoodActivities = [];

    // filter routes such that direct connections to start and end point + route distance is roughly the same as the given distance
    let lists = [
        {isRoute: true, isActivity: false, routes: result.goodRoutes},
        {isRoute: false, isActivity: false, routes: result.goodSegments},
        {isRoute: false, isActivity: true, routes: result.goodActivities}
    ];

    for (let routes of lists) {
        for (let route of routes.routes) {

            let startPoint = [];
            let endPoint = [];
            if (!route.isRoute && !route.isActivity) {
                startPoint = route.strava.start_latlng;
                endPoint = route.strava.end_latlng;
            } else {
                startPoint = [route.geo[0].location.coordinates[1], route.geo[0].location.coordinates[0]];
                endPoint = [route.geo[route.geo.length - 1].location.coordinates[1], route.geo[route.geo.length - 1].location.coordinates[0]];
            }

            if (startPoint === [] || endPoint === []) {
                Log.error(TAG, 'Route does not have start and end latlng strava properties', route);
            }

            let distanceToStart = geolib.getDistance(
                {latitude: query.start.lat, longitude: query.start.lng},
                {latitude: startPoint[0], longitude: startPoint[1]}
            );

            let distanceToEnd = geolib.getDistance(
                {latitude: query.start.lat, longitude: query.start.lng},
                {latitude: endPoint[0], longitude: endPoint[1]}
            );

            const totalDistance = route.distance + distanceToStart + distanceToEnd;

            // add the distance attribute to the object for later sorting
            route.lowerBoundDistance = totalDistance;

            if (totalDistance - query.distance * 0.1 > query.distance) {
                // Log.debug(TAG, 'Lower bound on route with route/segment is too long: ' + totalDistance);
            } else {
                if (routes.isRoute) {
                    newGoodRoutes.push(route);
                } else {
                    if (routes.isActivity) {
                        newGoodActivities.push(route);
                    } else {
                        newGoodSegments.push(route);
                    }
                }
            }
        }
    }

    result.goodRoutes = newGoodRoutes;
    result.goodSegments = newGoodSegments;
    result.goodActivities = newGoodActivities;

    Log.debug(TAG, result.goodRoutes.length + ' possible routes after lower bound filter: ', /* result.goodRoutes.map(r => r.lowerBoundDistance + ' (' + r.title + ')')*/);
    Log.debug(TAG, result.goodSegments.length + ' possible segments after lower bound filter: ', /* result.goodSegments.map(s => s.lowerBoundDistance + ' (' + s.title + ')')*/);
    Log.debug(TAG, result.goodActivities.length + ' possible own activities after lower bound filter: ', /* result.goodSegments.map(s => s.lowerBoundDistance + ' (' + s.title + ')')*/);

    return result;
};

/**
 * Combine routes and segments into combos (combinations that are, when combined
 * in a route, still shorter in the lower bound than the max distance
 */
const combine = async function (query, result) {
    Log.debug(TAG, '');
    Log.log(TAG, '== Combine ==');

    let start = {
        name: 'start',
        start: query.start,
        end: query.start,
        distance: 0,
        successors: [],
        lowerBoundDistance: 0,
        inv: '',
        isActivity: false,
        isInv: false,
        firstGeo: 0,
        lastGeo: 0,
        id: 0,
        route: null,
    };
    let end = {
        name: 'end',
        start: query.end,
        end: query.end,
        disatnce: 0,
        successors: [],
        lowerBoundDistance: 0,
        inv: '',
        isActivity: false,
        isInv: false,
        firstGeo: 0,
        lastGeo: 0,
        id: 0,
        route: null,
    };

    let routeNodes = generateNodes(result.goodRoutes, false, query);
    let segmentNodes = generateNodes(result.goodSegments, false, query);
    let activityNodes = generateNodes(result.goodActivities, true, query);

    let nodes = [];
    nodes.push.apply(nodes, routeNodes);
    nodes.push.apply(nodes, segmentNodes);

    connectNodes(start, end, nodes);
    let explorativeResultPaths = makeComboPaths(start, end, nodes, query, false);
    let explorativePathLength = 0;
    let explorativePathComponentCount = 0;
    explorativeResultPaths.forEach((path) => {
        explorativePathLength += path.distance;
        explorativePathComponentCount += path.path.length;
    });
    Log.debug(TAG, 'Found ' + explorativeResultPaths.length + ' explorative parths paths with average distance ' + explorativePathLength / explorativeResultPaths.length
        + ' and ' + explorativePathComponentCount / explorativeResultPaths.length + ' components');


    nodes = [];
    nodes.push.apply(nodes, activityNodes);
    nodes.push.apply(nodes, routeNodes);
    connectNodes(start, end, nodes);
    let familiarResultPaths = makeComboPaths(start, end, nodes, query, true);
    let familiarPathLength = 0;
    let familiarPathComponentCount = 0;
    familiarResultPaths.forEach((path) => {
        familiarPathLength += path.distance;
        familiarPathComponentCount += path.path.length;
    });
    Log.debug(TAG, 'Found ' + familiarResultPaths.length + ' familair parths paths with average distance ' + familiarPathLength / familiarResultPaths.length
        + ' and ' + familiarPathComponentCount / familiarResultPaths.length + ' components');

    for (let pathObject of explorativeResultPaths) {
        const comboObject = {
            lowerBoundDistance: pathObject.distance,
            // singleRoute: true,
            explorative: true,
            mixed: true,
            parts: pathObject.path
        };
        result.explorativeCombos.push(comboObject);
    }

    for (let pathObject of familiarResultPaths) {
        const comboObject = {
            lowerBoundDistance: pathObject.distance,
            // singleRoute: true,
            explorative: false,
            mixed: true,
            parts: pathObject.path
        };
        result.familiarCombos.push(comboObject);
    }

    Log.debug(TAG, result.explorativeCombos.length + ' explorative combos generated');
    Log.debug(TAG, result.familiarCombos.length + ' familiar combos generated');

    return result;
};

/**
 * Sort combos on the lower bound total distance in descending order
 */
const sortAndReduce = async function (query, result) {
    Log.debug(TAG, '');
    Log.log(TAG, '== Sort and Reduce ==');

    result.explorativeCombos.sort(function (a, b) {
        return (b.parts.length * 1000000 + b.lowerBoundDistance) - (a.parts.length * 1000000 + a.lowerBoundDistance);
    });

    result.familiarCombos.sort(function (a, b) {
        return b.lowerBoundDistance - a.lowerBoundDistance;
    });

    // Log.log(TAG, result.explorativeCombos.length + ' sorted explorative combos:  ', result.explorativeCombos.map(r => r.lowerBoundDistance + 'm (' + r.parts.length + ' parts)'));
    // Log.log(TAG, result.familiarCombos.length + ' sorted familiar combos: ', result.familiarCombos.map(r => r.lowerBoundDistance + 'm (' + r.parts.length + ' parts)'));

    // reduce the list of explorative combos to a fixed number
    const keepBest = 3;
    while (result.explorativeCombos.length > keepBest) {
        let indexFromStart = result.explorativeCombos[0];
        let indexFromEnd = result.explorativeCombos[result.explorativeCombos.length - 1];
        if (indexFromStart.lowerBoundDistance - query.distance > query.distance - indexFromEnd.lowerBoundDistance) {
            result.explorativeCombos = result.explorativeCombos.slice(1, result.explorativeCombos.length);    // remove item form the beginning
        } else {
            result.explorativeCombos = result.explorativeCombos.slice(0, result.explorativeCombos.length - 1);    // remove item from the end
        }
    }

    // reduce the list of familiar combos to a fixed number
    while (result.familiarCombos.length > keepBest) {
        let indexFromStart = result.familiarCombos[0];
        let indexFromEnd = result.familiarCombos[result.familiarCombos.length - 1];
        if (indexFromStart.lowerBoundDistance - query.distance > query.distance - indexFromEnd.lowerBoundDistance) {
            result.familiarCombos = result.familiarCombos.slice(1, result.familiarCombos.length);    // remove item form the beginning
        } else {
            result.familiarCombos = result.familiarCombos.slice(0, result.familiarCombos.length - 1);    // remove item from the end
        }
    }

    Log.debug(TAG, result.explorativeCombos.length + ' filtered explorative combos: ', result.explorativeCombos.map(r => r.lowerBoundDistance + ' m (' + r.parts.length + ' parts)'));
    Log.debug(TAG, result.familiarCombos.length + ' filtered familiar combos: ', result.familiarCombos.map(r => r.lowerBoundDistance + ' m (' + r.parts.length + ' parts)'));
    return result;
};

/**
 * Populates the remaining routes and generates with the full geo data
 */
const populate = async function (query, result) {
    Log.debug(TAG, '');
    Log.log(TAG, '== Populate ==');

    for (let ci = 0; ci < result.explorativeCombos.length; ci++) {
        let combo = result.explorativeCombos[ci];
        for (let pi = 0; pi < combo.parts.length; pi++) {
            let part = combo.parts[pi];

            // make sure every part of every combo has the geo field populated
            if (part.id !== 0) {
                result.explorativeCombos[ci].parts[pi].route = await Route.load(part.id);
            }
        }
    }

    for (let ci = 0; ci < result.familiarCombos.length; ci++) {
        let combo = result.familiarCombos[ci];
        for (let pi = 0; pi < combo.parts.length; pi++) {
            let part = combo.parts[pi];

            // make sure every part of every combo has the geo field populated
            if (part.id !== 0) {
                if (part.isActivity) {
                    result.familiarCombos[ci].parts[pi].route = await query.user.activities.find((act) => act._id === part.id);
                } else {
                    result.familiarCombos[ci].parts[pi].route = await Route.load(part.id);
                }
            }
        }
    }

    Log.debug(TAG, result.explorativeCombos.length + ' explorative combos have been populated');
    Log.debug(TAG, result.familiarCombos.length + ' familiar combos have been populated');

    return result;
};

/**
 * Generate candidates from a 3rd party routing service using combos
 */
const generateCandidates = async function (query, result) {
    Log.debug(TAG, '');
    Log.log(TAG, '== Generate Candidates ==');
    if (result.explorativeCombos.length === 0 /* TODO || result.familiarCombos.length === 0 */) {
        result.candidates = [];
        return result;
    }

    let explorativeRoutes = [];
    let familiarRoutes = [];

    // for every combo, generate a route
    for (let combo of result.explorativeCombos) {
        // start with the starting point
        let coordinates = [{
            'coordinates': [
                query.start.lng,
                query.start.lat
            ],
            'type': 'Point'
        }];

        let geosTotal = 0;
        for (let part of combo.parts) {
            if (part.id !== 0) {
                geosTotal += part.route.geo.length;
            }
        }
        let ratio = 23 / geosTotal;

        // add all waypoints of the segment/route
        for (let part of combo.parts) {
            if (part.id !== 0) {
                const maxAllowedWaypoints = Math.max(Math.floor(part.route.geo.length * ratio), 2);
                // Log.debug(TAG, maxAllowedWaypoints);
                let keepEvery = Math.ceil(part.route.geo.length / (maxAllowedWaypoints - 2));
                if (keepEvery > 1) {
                    // we have too many waypoints, downsample to something smaller
                    keepEvery = Math.ceil(keepEvery);
                    const waypointsTemp = Object.assign([], part.route.geo);
                    part.route.geo = [waypointsTemp[0]];     // start point must not be deleted
                    let counter = 0;

                    for (let wp of waypointsTemp) {
                        if (counter % keepEvery === 0 && coordinates.length + part.route.geo.length + 2 < 25) {
                            part.route.geo.push(wp);
                        }
                        ++counter;
                    }
                    part.route.geo.push(waypointsTemp[waypointsTemp.length - 1]);   // end point must also definitely be a waypoint
                    // Log.debug(TAG, part.route.geo.length);

                }
                coordinates = coordinates.concat(part.route.geo.map(g => g.location));
            }
        }

        // add the end point last
        coordinates.push({
            'coordinates': [
                query.end.lng,
                query.end.lat
            ],
            'type': 'Point'
        });

        Log.debug(TAG, 'READY for OSRM: ' + coordinates.length);

        let route = await osrm.findRoute({waypoints: coordinates});
        if (route.distance > 0) {
            // save what parts are included in this route
            route.parts = combo.parts;

            // add this route to the list of all generated routes
            explorativeRoutes.push(route);
        }
        break;
    }

    // sort the resulting routes by distance
    explorativeRoutes.sort(function (a, b) {
        return Math.abs(b.distance - query.distance) - Math.abs(a.distance - query.distance);
    });


    // only keep the best n routes by removing items form the front and end of the array
    const keepBest = 2;
    while (explorativeRoutes.length > keepBest) {
        let indexFromStart = explorativeRoutes[0];
        let indexFromEnd = explorativeRoutes[explorativeRoutes.length - 1];
        if (indexFromStart.distance - query.distance > query.distance - indexFromEnd.distance) {
            explorativeRoutes = explorativeRoutes.slice(1, explorativeRoutes.length);    // remove item form the beginning
        } else {
            explorativeRoutes = explorativeRoutes.slice(0, explorativeRoutes.length - 1);    // remove item from the end
        }
    }

    Log.debug(TAG, explorativeRoutes.length + ' explorative routes generated by OSRM: ', explorativeRoutes.map(r => r.distance));
    Log.debug(TAG, familiarRoutes.length + ' familiar routes generated by OSRM: ', familiarRoutes.map(r => r.distance));

    result.candidates = explorativeRoutes;
    result.familiarCandidates = familiarRoutes;
    return result;
};

/**
 * Filters the generated routes to only leave ones that are mostly familiar
 */
const familiarityFilter = async function (query, result) {
    Log.debug(TAG, '');
    Log.log(TAG, '== Familiarity Filter ==');

    if (result.candidates.length === 0) {
        return result;
    }

    for (let route of result.candidates) {
        let leave = 25;
        if (route.waypoints.length < leave) {
            leave = route.waypoints.length;
        }
        const takeEvery = Math.ceil(route.waypoints.length / leave);    // parameter for performance, only take every xth route point, 1 = every

        let matches = 0;
        let exploredGeos = [];

        for (let activity of query.user.activities) {
            for (let g of activity.geo) {
                exploredGeos.push(g._id.toString());
            }
        }

        let waypointIndex = -1;
        for (let waypoint of route.waypoints) {
            waypointIndex++;
            if (waypointIndex % takeEvery === 0) {
                const options = {
                    distance: 280,
                    latitude: waypoint[1],
                    longitude: waypoint[0]
                };

                let matching = false;
                let geos = await Geo.findWithinRadius(options);
                if (!geos) {
                    continue;
                }
                geos.some(function (geo) {
                    if (exploredGeos.includes(geo._id.toString())) {
                        matching = true;
                    }
                    return matching;
                });

                if (matching) {
                    matches++;
                }
            }
        }
        route.familiarityScore = matches / leave;
    }

    // sort explorative candidates by ascending familiarity
    result.candidates.sort(function (a, b) {
        return a.familiarityScore - b.familiarityScore;
    });

    // sort familiar candidates by descending familiarity
    result.familiarCandidates.sort(function (a, b) {
        return b.familiarityScore - a.familiarityScore;
    });

    const keepBest = 1;
    if (result.candidates.length) {
        result.candidates = result.candidates.slice(0, keepBest);
        Log.debug(TAG, 'Explorative route has familiarity score ' + result.candidates[0].familiarityScore);
    }

    if (result.familiarCandidates.length) {
        result.familiarCandidates = result.familiarCandidates.slice(0, keepBest);
        Log.debug(TAG, 'Familiar route has familiarity score ' + result.familiarCandidates[0].familiarityScore);
    }

    return result;
};

/**
 * Create Route objects from the generated candidates
 */
const createRoutes = async function (query, result) {
    Log.debug(TAG, '');
    Log.log(TAG, '== Create Routes ==');

    if (result.candidates.length === 0) {
        return result;
    }

    let generatedRoutes = [];
    let familiarityScores = [];

    for (let candidate of result.candidates) {
        // get the user
        const title = 'New Route (' + Math.floor(candidate.distance / 1000) + ' km)';
        const description = 'This route has been generated. Select this route and change the title and description.';
        let id = routes.makeid({
            title: title,
            distance: candidate.distance,
            start: candidate.waypoints[0],
            end: candidate.waypoints[candidate.waypoints.length - 1]
        });
        let route = new Route({
            stravaId: id,
            title: title,
            body: description,
            location: '',
            comments: [],
            tags: '',
            geo: [],
            user: query.user._id,
            distance: candidate.distance,
            isRoute: true,
            isGenerated: true,
            queryDistance: query.distance,
            parts: candidate.parts.map((p) => p.route).slice(1, candidate.parts.length - 1)
        });

        const options = {
            criteria: {
                stravaId: id,
                isRoute: true,
                isGenerated: true
            }
        };

        let existingRoute = await Route.load_options(options);
        if (existingRoute) {
            Log.debug(TAG, 'Route already exists (' + existingRoute.title + ')');
            existingRoute.familiarityScore = candidate.familiarityScore;
            generatedRoutes.push(existingRoute);
            familiarityScores.push(candidate.familiarityScore);

            continue;
        }

        // if the route does not already exist, save it
        await route.save();

        // create a geo object in the db for each waypoint
        let geos = [];

        for (let waypoint of candidate.waypoints) {
            const geo = new Geo({
                name: 'Generated',
                location: {
                    type: 'Point',
                    coordinates: [waypoint[0], waypoint[1]]
                },
            });

            if (route != null) {
                if (route._id != null) {
                    // add the route reference to the geo
                    geo.routes.push(route);
                } else {
                    Log.error(TAG, 'Route of the stream was not null but had no _id');
                    continue;
                }
            }
            geos.push(geo);
            await geo.save();
        }

        // add the created geos to the route and save it again
        route.geo = geos;
        await route.save();

        importExport.exportRoute({
            routeData: route,
            query: {},
        });

        Log.log(TAG, 'Created new route (' + route.title + ', with ' + route.geo.length + ' waypoints)');

        generatedRoutes.push(route);
        familiarityScores.push(candidate.familiarityScore);
    }

    result.resultRoutes = generatedRoutes;
    result.familiarityScores = familiarityScores;

    return result;
};

const respond = async function (query, result) {
    Log.debug(TAG, '');
    Log.log(TAG, '== Respond ==');

    let resultRoutes = result.resultRoutes;

    /* if (query.preference === 'discover') {
        resultRoutes.sort(function (a, b) {
            return b.familiarityScore - a.familiarityScore;
        });
    }
    if (query.preference === 'distance') {
        resultRoutes.sort(function (a, b) {
            return b.distance - a.distance;
        });
    } else {
        resultRoutes.sort(function (a, b) {
            return b.distance + ((1 - b.familiarityScore) * a.distance) - a.distance + ((1 - a.familiarityScore) * b.distance);
        });
    } */
    Log.debug(TAG, 'FAM', result.familiarityScores);

    let ratings = [];
    for (let r of resultRoutes) {
        let o = {
            route: r._id,
            rating: 0,
            comment: '',
        };
        ratings.push(o);
    }

    let creatorResult = new CreatorResult(
        {
            user: query.user._id,
            query: {
                distance: query.distance,
                start: query.start,
                end: query.end,
                preference: query.preference,
            },
            generatedRoutes: resultRoutes,
            familiarityScores: result.familiarityScores,
            routeRatings: ratings,
            acceptedRoutes: [],
        });

    query.user.creatorResults.push(creatorResult._id);
    await query.user.save();
    await creatorResult.save();
    let cr = await CreatorResult.load(creatorResult._id);
    query.response.json(cr);
    return result;
};

const logAll = function (query, result) {
    if (result.resultRoutes.length > 0) {
        Log.debug(TAG, 'Created these routes: ', result.resultRoutes.map(r => r.title + '\t (' + r.distance + ')'));
    }
    else if (result.candidates.length > 0) {
        Log.debug(TAG, 'Found these candidate routes: ', result.candidates.map(r => r.title + '\t (' + r.distance + ')'));
    }
    else if (result.combos.length === 0) {
        let tempRoutes = result.goodRoutes;
        let tempSegments = result.goodSegments;

        for (let route of tempRoutes) {
            route.geo = [];
        }

        for (let segment of tempSegments) {
            segment.geo = [];
        }

        Log.debug(TAG, result.goodRoutes.length + ' routes: ', tempRoutes);
        Log.debug(TAG, result.goodSegments.length + ' segments: ', tempSegments);
    } else {
        let tempCombos = result.combos;

        for (let combo of tempCombos) {
            for (let part of combo.parts) {
                part.geo = [];
            }
        }
        Log.debug(TAG, tempCombos.length + ' combos: ', tempCombos);

        if (result.finalRoutes.length > 0) {
            let tempRoutes = result.finalRoutes;

            for (let route of tempRoutes) {
                route.geo = [];
            }
            Log.debug(TAG, tempRoutes.length + ' final routes: ', tempRoutes);
        }
    }
};

/**
 * Keep routes and segments where each geo is within the radius of half the
 * route distance around the starting point (i.e. it must not leave the radius).
 */
const radiusFilter = async function (query, result) {
    Log.debug(TAG, 'Radius Filter');
    const options = {
        latitude: query.start.lat,
        longitude: query.start.lng,
        distance: query.radius,
        select: {_id: 1, distance: 2, routes: 3}
    };

    let radiusGeos = await Geo.findWithinRadius(options);
    radiusGeos = radiusGeos.filter(function (geo) {
        return geo.routes.length > 0;
    });

    // filter such that only the routes that are completely within the radius remain
    result.goodRoutes = result.goodRoutes.filter(function (route) {
        const takeEvery = Math.ceil(route.geo.length * 0.1);    // parameter for performance, only take every xth route point, 1 = every
        let count = 0;

        // return whether there is no geo that is not in the radius
        return (!(route.geo.some(function (routeGeo) {
            count++;
            if (count % takeEvery !== 0) {
                return false;
            }
            // return whether the element is not in the radius geos
            return !(radiusGeos.some(function (radiusGeo) {
                return (radiusGeo._id.toString().trim() === routeGeo._id.toString().trim());
            }));
        })));
    });

    // filter such that only the segments that are completely not outside remain
    result.goodSegments = result.goodSegments.filter(function (segment) {
        const takeEvery = Math.ceil(segment.geo.length * 0.1);    // parameter for performance, only take every xth route point, 1 = every
        let count = 0;

        // if there is no geo that is not in the radius, return true
        return (!(segment.geo.some(function (segmentGeo) {
            count++;
            if (count % takeEvery !== 0) {
                return false;
            }
            // if the element is not in the radius geos, then return true
            return !(radiusGeos.some(function (radiusGeo) {

                return (radiusGeo._id.toString().trim() === segmentGeo._id.toString().trim());
            }));
        })));
    });
    // now our routes and segments arrays only contain routes where no geo is outside of the radius

    Log.debug(TAG, result.goodRoutes.length + ' possible segments after radius filter: ', result.goodRoutes.map(s => s.distance + ' (' + s.title + ')'));
    Log.debug(TAG, result.goodSegments.length + ' possible segments after radius filter: ', result.goodSegments.map(s => s.distance + ' (' + s.title + ')'));

    return result;
};

const printAllPathsUntil = function (source,
                                     destination,
                                     localPathList,
                                     localDistance,
                                     maxDepth,
                                     minDepth,
                                     maxDistance,
                                     resultPaths,
                                     stopAfter,
                                     requireActivity) {
    source.isVisited = true;
    if (source === destination && localPathList.length >= minDepth && resultPaths.length < stopAfter) {
        let found = true;
        if (requireActivity) {
            found = false;
            for (let node of localPathList) {
                if (node.isActivity) {
                    found = true;
                }
            }
        }
        if (found) {
            const clonePath = localPathList.slice();
            resultPaths.push({
                path: clonePath,
                distance: localDistance
            });
        }
    }

    // Recur for all the vertices adjacent to current vertex
    source.successors.forEach(function (succ) {

        // abort if algorithm parameters are violated
        if (localDistance + source.distance + succ.distance >= maxDistance
            || localPathList.length >= maxDepth
            || resultPaths.length >= stopAfter) {
            return;
        }

        // prevent cycles going through the same track
        if (!succ.node.isVisited) {
            const addedDistance = source.distance + succ.distance;
            localPathList.push(succ.node);
            printAllPathsUntil(succ.node, destination, localPathList, localDistance + addedDistance, maxDepth, minDepth, maxDistance, resultPaths, stopAfter, requireActivity);
            localPathList.splice(localPathList.indexOf(succ.node), 1);
        }
    });
    source.isVisited = false;
};


