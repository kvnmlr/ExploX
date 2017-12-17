'use strict';

/**
 * Module dependencies.
 */

const mongoose = require('mongoose');
const StravaStrategy = require('passport-strava').Strategy;
const config = require('../');
const User = mongoose.model('User');
const Role = mongoose.model('Role');

/**
 * Expose
 */

module.exports = new StravaStrategy({
        clientID: config.strava.clientID,
        clientSecret: config.strava.clientSecret,
        callbackURL: config.strava.callbackURL
    },
    function (accessToken, refreshToken, profile, done) {
        const options = {
            criteria: {'strava.id': parseInt(profile.id)}
        };
        User.load_options(options, function (err, user) {
            if (err) return done(err);
            if (!user) {
                var options = {
                    criteria: {'name': 'user'}
                };
                Role.load_options(options, function (err, role) {
                    if (err) return done(err);
                    if (role) {
                        user = new User({
                            name: profile.displayName,
                            email: profile._json.email,
                            username: profile.name.first,
                            provider: 'strava',
                            strava: profile._json,
                            authToken: accessToken,
                            stravaId: profile.id,
                            role: role
                        });
                        user.save(function (err) {
                            if (err) console.log(err);
                            return done(err, user);
                        });
                    }
                });
            } else {
                return done(err, user);
            }
        });
    }
);