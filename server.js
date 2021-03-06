'use strict';

const Log = require('./app/utils/logger');
const TAG = 'server';
require('dotenv').config();
const fs = require('fs');
const join = require('path').join;
const express = require('express');
const app = express();
const mongoose = require('mongoose');
const cluster = require('cluster');
const favicon = require('serve-favicon');
const passport = require('passport');
const config = require('./config');
const models = join(__dirname, 'app/models');

const port = process.env.PORT || 3000;
process.setMaxListeners(0);

const os = require('os');
const numCPUs = os.cpus().length;


module.exports = app;
module.exports.config = config;
module.exports.mongoose = mongoose;

// Bootstrap models
fs.readdirSync(models)
    .filter(file => ~file.search(/^[^.].*\.js$/))
    .forEach(file => require(join(models, file)));

// Bootstrap routes
require('./config/passport')(passport);
require('./config/express')(app, passport);
require('./config/routes')(app, passport);

if (cluster.isMaster) {
    Log.log(TAG, '_____Starting Server_____');
    Log.log(TAG, 'Starting ' + numCPUs + ' workers on port ' + port);

    connect()
        .on('error', console.log)
        .on('disconnected', connect)
        .once('open', initialize);

    if (app.get('env') !== 'test') {
        for (let i = 0; i < numCPUs; i++) {
            cluster.fork();
        }

        /* Object.keys(cluster.workers).forEach(function (id) {
            Log.debug(TAG, 'Worker with PID ' + cluster.workers[id].process.pid + ' is ready');
        }); */
    }

    cluster.on('exit', function (deadWorker) {
        // Restart the worker
        const worker = cluster.fork();

        // Log the event
        Log.error(TAG, 'Worker ' + deadWorker.process.pid + ' has died');
        Log.log(TAG, 'Worker ' + worker.process.pid + ' was born');
    });

} else {
    connect()
        .on('error', console.log)
        .on('disconnected', connect)
        .once('open', listen);
}

function listen () {
    if (app.get('env') === 'test') return;
    app.listen(port);
}

async function initialize () {
    if (app.get('env') === 'test') return;
    require('./init').init();
}

function connect () {
    const options = {
        keepAlive: true,
        autoIndex: true,
        reconnectTries: Number.MAX_VALUE,   // Always try to reconnect
        reconnectInterval: 500,             // Reconnect every 500ms
        bufferMaxEntries: 0                 // If not connected, return errors immediately
    };
    mongoose.Promise = global.Promise;
    mongoose.connect(config.db, options);
    return mongoose.connection;
}
