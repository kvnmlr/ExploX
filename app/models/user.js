'use strict';

/**
 * Module dependencies.
 */

const mongoose = require('mongoose');
const crypto = require('crypto');
const ObjectId = require('mongoose').Types.ObjectId;
const Schema = mongoose.Schema;
const oAuthTypes = ['strava'];
const Log = require('../utils/logger');
const TAG = 'user';

/**
 * User Schema
 */

const UserSchema = new Schema({
    name: { type: String, default: '' },
    email: { type: String, default: '', index: { unique: true } },
    username: { type: String, default: '', trim: true, index: { unique: true } },
    provider: { type: String, default: '' },
    hashed_password: { type: String, default: '' },
    salt: { type: String, default: '' },
    authToken: { type: String, default: '' },
    stravaId: { type: String, default: '' },
    strava: {},
    routes: [{ type: Schema.ObjectId, ref: 'Route' }],
    activities: [{ type: Schema.ObjectId, ref: 'Activity' }],
    role: { type: String, default: 'user' },
    createdAt: { type: Date, default: Date.now },
    lastLogin: { type: Date, default: Date.now }
});

const validatePresenceOf = value => value && value.length;

/**
 * Virtuals
 */

UserSchema
    .virtual('password')
    .set(function (password) {
        this._password = password;
        this.salt = this.makeSalt();
        this.hashed_password = this.encryptPassword(password);
    })
    .get(function () {
        return this._password;
    });

/**
 * Validations
 */

// the below 5 validations only apply if you are signing up traditionally

UserSchema.path('name').validate(function (name) {
    if (this.skipValidation()) return true;
    return name.length;
}, 'Name cannot be blank');

UserSchema.path('email').validate(function (email) {
    if (this.skipValidation()) return true;
    return email.length;
}, 'Email cannot be blank');

UserSchema.path('email').validate(function (email) {
    const User = mongoose.model('User');
    if (this.skipValidation()) return (true);

    // Check only when it is a new user or when email field is modified
    if (this.isNew || this.isModified('email')) {
        User.find({ email: email }).exec(function (err, users) {
            return (!err && users.length === 0);
        });
    } else return (true);
}, 'Email already exists');

UserSchema.path('username').validate(function (username) {
    if (this.skipValidation()) return true;
    return username.length;
}, 'Username cannot be blank');

UserSchema.path('hashed_password').validate(function (hashed_password) {
    if (this.skipValidation()) return true;
    return hashed_password.length && this._password.length;
}, 'Password cannot be blank');


/**
 * Pre-save hook
 */

UserSchema.pre('save', function (cb) {
    if (!this.isNew) return cb();

    if (!validatePresenceOf(this.password) && !this.skipValidation()) {
        cb(new Error('Invalid password'));
    } else {
        cb();
    }
});

/**
 * Methods
 */

UserSchema.methods = {

    /**
     * Authenticate - check if the passwords are the same
     *
     * @param {String} plainText
     * @return {Boolean}
     * @api public
     */

    authenticate: function (plainText) {
        return this.encryptPassword(plainText) === this.hashed_password;
    },

    /**
     * Make salt
     *
     * @return {String}
     * @api public
     */

    makeSalt: function () {
        return Math.round((new Date().valueOf() * Math.random())) + '';
    },

    /**
     * Encrypt password
     *
     * @param {String} password
     * @return {String}
     * @api public
     */

    encryptPassword: function (password) {
        if (!password) return '';
        try {
            return crypto
                .createHmac('sha1', this.salt)
                .update(password)
                .digest('hex');
        } catch (err) {
            return '';
        }
    },

    /**
     * Validation is not required if using OAuth
     */

    skipValidation: function () {
        return ~oAuthTypes.indexOf(this.provider) || !this._password;
    }
};

/**
 * Statics
 */

UserSchema.statics = {

    /**
     * Populates all activities, this can get quite large so only use it when all user Geo data is required.
     * @param _id
     * @param options
     * @returns {Promise}
     */
    load_full: function (_id, options) {
        options.select = options.select || '';
        return this.findOne({ _id: ObjectId(_id) })
            .populate({
                path: 'activities',
                populate: {
                    path: 'geo',
                    model: 'Geo'
                }
            })
            .populate({
                path: 'routes',
            })
            .select(options.select)
            .exec();
    },    /**
     * Load
     *
     * @param {Object} options
     * @api private
     */

    load_options: function (options, cb) {
        options.select = options.select || '';
        return this.findOne(options.criteria)
            .populate('activities')
            .select(options.select)
            .exec(cb);
    },

    /**
     * Find route by id
     *
     * @param {ObjectId} _id the id
     * @api private
     */

    load: function (_id) {
        return this.load_options({ criteria: { _id: _id } });
    },

    /**
     * Update user by id
     *
     * @param {ObjectId} id
     * @param data data to update
     * @api private
     */

    update_user: function (id, data) {
        return this.update({ _id: ObjectId(id) }, data).exec();
    },

    list: function (options) {
        const criteria = options.criteria || {};
        return this.find(criteria)
            .sort({ createdAt: -1 })
            .exec();
    }

};

mongoose.model('User', UserSchema);
