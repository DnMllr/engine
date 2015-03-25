'use strict';

var Particle = require('./bodies/Particle');
var Constraint = require('./constraints/Constraint');
var Force = require('./forces/Force');

var Vec3 = require('famous-math/src/Vec3');
var Quaternion = require('famous-math/src/Quaternion');

var VEC_REGISTER = new Vec3();
var XYZ_REGISTER = new Vec3();
var QUAT_REGISTER = new Quaternion();
var DELTA_REGISTER = new Vec3();

/**
 * Singleton PhysicsEngine object.
 * Manages bodies, forces, constraints.
 *
 * @class PhysicsEngine
 * @param {Object} options A hash of configurable options.
 */
function PhysicsEngine(options) {
    options = options || {};
    /** @prop bodies The bodies currently active in the engine. */
    this.bodies = [];
    /** @prop forces The forces currently active in the engine. */
    this.forces = [];
    /** @prop constraints The constraints currently active in the engine. */
    this.constraints = [];

    /** @prop step The time between frames in the engine. */
    this.step = options.step || 1000/60;
    /** @prop iterations The number of times each constraint is solved per frame. */
    this.iterations = options.iterations || 10;
    /** @prop _indexPool Pools of indicies to track holes in the arrays. */
    this._indexPools = {
        bodies: [],
        forces: [],
        constraints: []
    };

    this._entityMaps = {
        bodies: {},
        forces: {},
        constraints: {}
    };

    this.speed = options.speed || 1.0;
    this.time = 0;
    this.delta = 0;

    this.origin = options.origin || new Vec3();
    this.orientation = options.orientation ? options.orientation.normalize() :  new Quaternion();

    this.prestep = [];
    this.poststep = [];

    this.frameDependent = options.frameDependent || false;

    this.transformBuffers = {
        position: [0, 0, 0],
        rotation: [0, 0, 0]
    };
}

/**
 * Set the origin of the world.
 *
 * @method setOrigin
 * @chainable
 * @param {Number} x The x component.
 * @param {Number} y The y component.
 * @param {Number} z The z component.
 */
PhysicsEngine.prototype.setOrigin = function(x, y, z) {
    this.origin.set(x, y, z);
    return this;
};

/**
 * Set the orientation of the world.
 *
 * @method setOrientation
 * @chainable
 * @param {Number} w The w component.
 * @param {Number} x The x component.
 * @param {Number} y The y component.
 * @param {Number} z The z component.
 */
PhysicsEngine.prototype.setOrientation = function(w, x, y, z) {
    this.orientation.set(w, x, y, z).normalize();
    return this;
}

/**
 * Private helper method to store an element in a library array.
 *
 * @method _addElement
 * @private
 * @param {Object} element The body, force, or constraint to add.
 * @param {String} key Where to store the element.
 */
function _addElement(context, element, key) {
    var map = context._entityMaps[key];
    if (map[element._ID] == null) {
        var library = context[key];
        var indexPool = context._indexPools[key];
        if (indexPool.length) map[element._ID] = indexPool.pop();
        else map[element._ID] = library.length;
        library[map[element._ID]] = element;
    }
}

/**
 * Private helper method to remove an element from a library array.
 *
 * @method _removeElement
 * @private
 * @param {Object} element The body, force, or constraint to remove.
 * @param {String} key Where to store the element.
 */
function _removeElement(context, element, key) {
    var map = context._entityMaps[key];
    var index = map[element._ID];
    if (index != null) {
        context._indexPools[key].push(index);
        context[key][index] = null;
        map[element._ID] = null;
    }
}

/**
 * Add a group of bodies, force, or constraints to the engine.
 *
 * @method add
 * @chainable
 */
PhysicsEngine.prototype.add = function add() {
    for (var j = 0, lenj = arguments.length; j < lenj; j++) {
        var entity = arguments[j];
        if (entity instanceof Array) {
            for (var i = 0, len = entity.length; i < len; i++) {
                var e = entity[i];
                this.add(e);
            }
        } else {
            console.log(entity.constructor.name)
            if (entity instanceof Particle) this.addBody(entity);
            else if (entity instanceof Constraint) this.addConstraint(entity);
            else if (entity instanceof Force) this.addForce(entity);
        }
    }
    return this;
};

/**
 * Remove a group of bodies, force, or constraints from the engine.
 *
 * @method remove
 * @chainable
 */
PhysicsEngine.prototype.remove = function remove() {
    for (var j = 0, lenj = arguments.length; j < lenj; j++) {
        var entity = arguments[j];
        if (entity instanceof Array) {
            for (var i = 0, len = entity.length; i < len; i++) {
                var e = entity[i];
                this.add(e);
            }
        } else {
            if (entity instanceof Particle) this.removeBody(entity);
            else if (entity instanceof Constraint) this.removeConstraint(entity);
            else if (entity instanceof Force) this.removeForce(entity);
        }
    }
    return this;
};

/**
 * Begin tracking a body.
 *
 * @method addBody
 * @param {Particle} body The body to track.
 */
PhysicsEngine.prototype.addBody = function addBody(body) {
    _addElement(this, body, 'bodies');
};

/**
 * Begin tracking a force.
 *
 * @method addForce
 * @param {Force} force The force to track.
 */
PhysicsEngine.prototype.addForce = function addForce(force) {
    _addElement(this, force, 'forces');
};

/**
 * Begin tracking a constraint.
 *
 * @method addConstraint
 * @param {Constraint} constraint The constraint to track.
 */
PhysicsEngine.prototype.addConstraint = function addConstraint(constraint) {
    _addElement(this, constraint, 'constraints');
};

/**
 * Stop tracking a body.
 *
 * @method removeBody
 * @param {Particle} body The body to stop tracking.
 */
PhysicsEngine.prototype.removeBody = function removeBody(body) {
    _removeElement(this, body, 'bodies')
};

/**
 * Stop tracking a force.
 *
 * @method removeForce
 * @param {Force} force The force to stop tracking.
 */
PhysicsEngine.prototype.removeForce = function removeForce(force) {
    _removeElement(this, force, 'forces')
};

/**
 * Stop tracking a constraint.
 *
 * @method removeConstraint
 * @param {Constraint} constraint The constraint to stop tracking.
 */
PhysicsEngine.prototype.removeConstraint = function removeConstraint(constraint) {
    _removeElement(this, constraint, 'constraints')
};

/**
 * Update the physics system to reflect the changes since the last frame. Steps forward in increments of
 * PhysicsEngine.step.
 *
 * @method update
 * @param {Number} time
 */
PhysicsEngine.prototype.update = function update(time) {
    if (this.time === 0) this.time = time;

    var bodies = this.bodies;
    var forces = this.forces;
    var constraints = this.constraints;

    var frameDependent = this.frameDependent;
    var step = this.step;
    var dt = step * 0.001;
    var speed = this.speed;

    var delta = this.delta;
    delta += (time - this.time) * speed;
    this.time = time;

    while(delta > step) {
        for (var i = 0, len = this.prestep.length; i < len; i++) {
            this.prestep[i](time, dt);
        }

        // Update Forces on particles
        for (var i = 0, numForces = forces.length; i < numForces; i++) {
            var force = forces[i];
            if (force === null) continue;
            force.update(time, dt);
        }

        // Tentatively update velocities
        for (var i = 0, numBodies = bodies.length; i < numBodies; i++) {
            var body = bodies[i];
            if (body === null) continue;
            _integrateVelocity(body, dt);
        }

        // Prep constraints for solver
        for (var i = 0, numConstraints = constraints.length; i < numConstraints; i++) {
            var constraint = constraints[i];
            if (constraint === null) continue;
            constraint.update(time, dt);
        }

        // Iteratively resolve constraints
        for (var j = 0, numIterations = this.iterations; j < numIterations; j++) {
            for (var i = 0; i < numConstraints; i++) {
                var constraint = constraints[i];
                if (constraint === null) continue;
                constraint.resolve(time, dt);
            }
        }

        // Increment positions and orientations
        for (var i = 0; i < numBodies; i++) {
            var body = bodies[i];
            if (body === null) continue;
            _integratePose(body, dt);
        }

        for (var i = 0, len = this.poststep.length; i < len; i++) {
            this.poststep[i](time, dt);
        }

        if (frameDependent) delta = 0;
        else delta -= step;
    }

    this.delta = delta;
};

/**
 * Get the transform equivalent to the Particle's position and orientation.
 *
 * @method getTransform
 * @return {Object} Position and rotation of the boy, taking into account
 * the origin and orientation of the world.
 */
PhysicsEngine.prototype.getTransform = function getTransform(body) {
    var o = this.origin;
    var oq = this.orientation;
    var transform = this.transformBuffers;

    var p = body.position;
    var q = body.orientation;
    var rot = q;
    var loc = p;
    var XYZ;

    if (oq.w !== 1) {
        rot = Quaternion.multiply(q, oq, QUAT_REGISTER)
        loc = oq.rotateVector(p, VEC_REGISTER);
    }
    var XYZ = rot.toEulerXYZ(XYZ_REGISTER);

    transform.position[0] = o.x+loc.x;
    transform.position[1] = o.y+loc.y;
    transform.position[2] = o.z+loc.z;

    transform.rotation[0] = XYZ.x;
    transform.rotation[1] = XYZ.y;
    transform.rotation[2] = XYZ.z;

    return transform;
};

/**
 * Update the Particle momenta based off of current incident force and torque.
 *
 * @method _integrateVelocity
 * @private
 * @param {Particle} body
 * @param {Number} dt delta time
 */
function _integrateVelocity(body, dt) {
    body.momentum.add(Vec3.scale(body.force, dt, DELTA_REGISTER));
    body.angularMomentum.add(Vec3.scale(body.torque, dt, DELTA_REGISTER));
    Vec3.scale(body.momentum, body.inverseMass, body.velocity);
    body.inverseInertia.vectorMultiply(body.angularMomentum, body.angularVelocity);
    body.force.clear();
    body.torque.clear();
};

/**
 * Update the Particle position and orientation based off current translational and angular velocities.
 *
 * @method _integratePose
 * @private
 * @param {Particle} body
 * @param dt {Number} delta time
 */
function _integratePose(body, dt) {
    if (body.restrictions !== 0) {
        var restrictions = body.restrictions;
        var x = null;
        var y = null;
        var z = null;
        var ax = null;
        var ay = null;
        var az = null;

        if (restrictions & 32) x = 0;
        if (restrictions & 16) y = 0;
        if (restrictions & 8) z = 0;
        if (restrictions & 4) ax = 0;
        if (restrictions & 2) ay = 0;
        if (restrictions & 1) az = 0;

        if (x !== null || y !== null || z !== null) body.setVelocity(x,y,z);
        if (ax !== null || ay !== null || az !== null) body.setAngularVelocity(ax, ay, az);
    }

    body.position.add(Vec3.scale(body.velocity, dt, DELTA_REGISTER));

    var w = body.angularVelocity;
    var q = body.orientation;
    var wx = w.x;
    var wy = w.y;
    var wz = w.z;

    var qw = q.w;
    var qx = q.x;
    var qy = q.y;
    var qz = q.z;

    var hdt = dt * 0.5;
    q.w += (-wx * qx - wy * qy - wz * qz) * hdt;
    q.x += (wx * qw + wy * qz - wz * qy) * hdt;
    q.y += (wy * qw + wz * qx - wx * qz) * hdt;
    q.z += (wz * qw + wx * qy - wy * qx) * hdt;

    q.normalize();

    body.updateInertia();
};

module.exports = PhysicsEngine;
