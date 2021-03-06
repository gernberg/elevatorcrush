


var createWorldCreator = function(timingService) {
    var creator = {};

    creator.createFloors = function(floorCount, floorHeight) {
        var floors = _.map(_.range(floorCount), function(e, i) {
            var yPos = (floorCount - 1 - i) * floorHeight;
            var floor = asFloor({}, i, yPos);
            return floor;
        });
        return floors;
    };
    creator.createElevators = function(elevatorCount, floorCount, floorHeight) {
        var elevators = _.map(_.range(elevatorCount), function(e, i) {
            var elevator = asMovable({});
            elevator.moveTo(200+60*i, null);
            elevator = asElevator(elevator, 2.6, floorCount, floorHeight);
            elevator.setFloorPosition(0);
            elevator.updateDisplayPosition();
            return elevator;
        });
        return elevators;
    };

    creator.createRandomUser = function(floorCount, floorHeight) {
        var user = asMovable({});
        user = asUser(user, floorCount, floorHeight);
        if(_.random(40) === 0) {
            user.displayType = "child";
        } else if(_.random(1) === 0) {
            user.displayType = "female";
        } else {
            user.displayType = "male";
        }
        return user;
    }

    creator.spawnUserRandomly = function(floorCount, floorHeight, floors) {
        var user = creator.createRandomUser(floorCount, floorHeight);
        user = asUser(user, floorCount, floorHeight);
        user.moveTo(100+_.random(40), 0);
        var currentFloor = _.random(1) == 0 ? 0 : _.random(floorCount - 1);
        var destinationFloor;
        if(currentFloor === 0) {
            // Definitely going up
            destinationFloor = _.random(1, floorCount - 1);
        } else {
            // Usually going down, but sometimes not
            if(_.random(10) == 0) {
                destinationFloor = (currentFloor + _.random(1, floorCount - 1)) % floorCount;
            } else {
                destinationFloor = 0;
            }
        }
        user.appearOnFloor(floors[currentFloor], destinationFloor);
        return user;
    }

    creator.createWorld = function(setTimeoutFunc, options) {
        console.log("Creating world with options", options);
        var defaultOptions = { floorHeight: 50, floorCount: 4, elevatorCount: 2, spawnRate: 0.5 };
        options = _.defaults(_.clone(options), defaultOptions);
        console.log("Options after default are", options);
        var world = {floorHeight: options.floorHeight, transportedCounter: 0};
        riot.observable(world);
        
        // Conclusion: Need to implement our own timeout generator
        // to get reliable high time factor (>100)
        world.timeScale = 1.0;
        world.timingObj = timingService.createTimingReplacement(setTimeoutFunc, 1);
        
        world.floors = creator.createFloors(options.floorCount, world.floorHeight);
        world.elevators = creator.createElevators(options.elevatorCount, options.floorCount, world.floorHeight);
        world.elevatorInterfaces = _.map(world.elevators, function(e) { return asElevatorInterface({}, e, options.floorCount); });
        world.users = [];
        world.transportedCounter = 0;
        world.transportedPerSec = 0.0;
        world.moveCount = 0;
        world.elapsedTime = 0.0;
        world.maxWaitTime = 0.0;
        world.avgWaitTime = 0.0;

        world.paused = true;
        world.setPaused = function(paused) {
            world.paused = paused;
            world.trigger("timescale_changed");
        }

        var recalculateStats = function() {
            world.transportedPerSec = world.transportedCounter / world.elapsedTime;
            world.moveCount = _.reduce(world.elevators, function(sum, elevator) { return sum+elevator.moveCount; }, 0);
            world.trigger("stats_changed");
        };

        var registerUser = function(user) {
            world.users.push(user);
            user.updateDisplayPosition();
            user.spawnTimestamp = world.elapsedTime;
            world.trigger("new_user", user);
            user.on("exited_elevator", function() {
                world.transportedCounter++;
                world.maxWaitTime = Math.max(world.maxWaitTime, world.elapsedTime - user.spawnTimestamp);
                world.avgWaitTime = (world.avgWaitTime * (world.transportedCounter - 1) + (world.elapsedTime - user.spawnTimestamp)) / world.transportedCounter;
                recalculateStats();
            });
        };

        // Bind them all together
        _.each(world.elevators, function(elevator) {
            elevator.on("entrance_available", function() {
                // Notify floors first because overflowing users
                // will press buttons again
                _.each(world.floors, function(floor, i) {
                    if(elevator.currentFloor == i) {
                        floor.elevatorAvailable(elevator);
                    }
                });

                _.each(world.users, function(user) {
                    if(user.currentFloor === elevator.currentFloor) {
                        user.elevatorAvailable(elevator, world.floors[elevator.currentFloor]);
                    }
                });
            });
        });

        var elapsedSinceSpawn = 1.001/options.spawnRate;
        var elapsedSinceStatsUpdate = 0.0;

        // Main update function
        world.update = function(dt) {
            if(!world.paused) {
                var scaledDt = dt * 0.001 * world.timeScale;

                try {
                    world.codeObj.update(scaledDt, world.elevatorInterfaces, world.floors);
                } catch(e) { world.paused = true; console.log("MOO", e); world.trigger("code_error", e); }

                var substeppingDt = scaledDt;
                while(substeppingDt > 0.0 && !world.timingObj.cancelEverything) {
                    var thisDt = Math.min(DT_MAX, substeppingDt);
                    world.elapsedTime += thisDt;
                    elapsedSinceSpawn += thisDt;
                    elapsedSinceStatsUpdate += thisDt;
                    while(elapsedSinceSpawn > 1.0/options.spawnRate) {
                        elapsedSinceSpawn -= 1.0/options.spawnRate;
                        registerUser(creator.spawnUserRandomly(options.floorCount, world.floorHeight, world.floors));
                    }

                    _.each(world.elevators, function(e) { e.update(thisDt); });
                    _.each(world.users, function(u) {
                        if(u.done && typeof u.cleanupFunction === "function") {
                            // Conclusion: Be careful using "off" riot function from event handlers - it alters 
                            // riot's callback list resulting in uncalled event handlers.
                            u.cleanupFunction();
                            u.cleanupFunction = null;
                        }
                        u.update(thisDt);
                        world.maxWaitTime = Math.max(world.maxWaitTime, world.elapsedTime - u.spawnTimestamp);
                    });

                    _.remove(world.users, function(u) { return u.removeMe; });

                    // Update stats last, because the event raised might cause this loop to stop
                    while(elapsedSinceStatsUpdate > 1.0/4 && !world.timingObj.cancelEverything) {
                        elapsedSinceStatsUpdate -= 1.0/4;
                        recalculateStats();
                    }
                    substeppingDt -= DT_MAX;
                }
            }
            _.each(world.elevators, function(e) { e.updateDisplayPosition(); });
            _.each(world.users, function(u) { u.updateDisplayPosition(); });
        };


        world.unWind = function() {
            world.timingObj.cancelEverything = true;
            _.each(world.elevators.concat(world.elevatorInterfaces).concat(world.users).concat(world.floors).concat([world]), function(obj) {
                obj.off("*");
                delete obj;
            });
            world.elevators = world.elevatorInterfaces = world.users = world.floors = [];
        }

        world.init = function(codeObj) {
            try {
                world.codeObj = codeObj;
                world.codeObj.init(world.elevatorInterfaces, world.floors);
                _.each(world.elevatorInterfaces, function(ei) { ei.pumpTaskQueue(); });
            } catch(e) { world.paused = true; world.trigger("code_error", e); }
        };

        return world;
    };

    return creator;
};


var createWorldController = function(dtMax) {
    var controller = {};
    controller.timeScale = 1.0;
    controller.isPaused = false;
    controller.start = function(world, animationFrameRequester) {
        var lastT = null;
        var updater = function(t) {
            if(!controller.isPaused && lastT !== null) {
                var dt = (t - lastT);
                while(dt > 0.0) {
                    var thisDt = Math.min(dtMax, dt);
                    world.update(thisDt * 0.001 * controller.timeScale);
                    dt -= dtMax;
                }
            }
            lastT = t;
            animationFrameRequester(updater);
        };
        animationFrameRequester(updater);
    };
    return controller;
};

