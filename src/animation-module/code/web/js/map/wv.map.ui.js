/*
 * NASA Worldview
 *
 * This code was originally developed at NASA/Goddard Space Flight Center for
 * the Earth Science Data and Information System (ESDIS) project.
 *
 * Copyright (C) 2013 - 2014 United States Government as represented by the
 * Administrator of the National Aeronautics and Space Administration.
 * All Rights Reserved.
 */

var wv = wv || {};
wv.map = wv.map || {};

wv.map.ui = wv.map.ui || function(models, config, ui) {

    var id = "wv-map";
    var selector = "#" + id;
    var cache = new Cache(100); // Save layers from days visited
    var animationDuration = 250;

    var self = {};
    self.proj = {}; // One map for each projection
    self.selected = null; // The map for the selected projection
    self.events = wv.util.events();

    var init = function() {
        if ( config.parameters.mockMap ) {
            return;
        }

        if ( wv.util.browser.firefox ) {
            animationDuration = 0;
        }

        // NOTE: iOS sometimes bombs if this is _.each instead. In that case,
        // it is possible that config.projections somehow becomes array-like.
        _.forOwn(config.projections, function(proj) {
            self.proj[proj.id] = createMap(proj);
        });

        models.proj.events.on("select", function() {
            updateProjection();
        });
        models.layers.events
            .on("add", addLayer)
            .on("remove", removeLayer)
            .on("visibility", updateLayerVisibilities)
            .on("opacity", updateOpacity)
            .on("update", updateLayerOrder);
        models.date.events.on("select", updateDate);
        models.palettes.events
            .on("set-custom", updateLookup)
            .on("clear-custom", updateLookup)
            .on("range", updateLookup)
            .on("update", updateLookup);
        $(window).on("resize", onResize);
        updateProjection(true);
    };

    var updateProjection = function(start) {
        if ( self.selected ) {
            // Keep track of center point on projection switch
            self.selected.previousCenter = self.selected.center;
            hideMap(self.selected);
        }
        self.selected = self.proj[models.proj.selected.id];
        var map = self.selected;
        reloadLayers();

        //Update the rotation buttons if polar projection to display correct value
        if(models.proj.selected.id !== "geographic")
            self.updateRotation();

        // If the browser was resized, the inactive map was not notified of
        // the event. Force the update no matter what and reposition the center
        // using the previous value.
        showMap(map);
        map.updateSize();

        if ( self.selected.previousCenter ) {
            self.selected.setCenter(self.selected.previousCenter);
        }

        // This is awkward and needs a refactoring
        if ( start ) {
            var projId = models.proj.selected.id;
            var extent = null;
            if ( models.map.extent ) {
                extent = models.map.extent;
            } else if ( !models.map.extent && projId === "geographic" ) {
                extent = models.map.getLeadingExtent();
            }
            if ( extent ) {
                map.getView().fitExtent(extent, map.getSize());
            }
        }
        updateExtent();
        onResize();
    };

    var onResize = function() {
        var map = self.selected;
        if ( map.small !== wv.util.browser.small ) {
            if ( wv.util.browser.small ) {
                map.removeControl(map.wv.scaleImperial);
                map.removeControl(map.wv.scaleMetric);
                $('#' + map.getTarget() + ' .select-wrapper').hide();
            } else {
                map.addControl(map.wv.scaleImperial);
                map.addControl(map.wv.scaleMetric);
                $('#' + map.getTarget() + ' .select-wrapper').show();
            }
        }
    };

    var hideMap = function(map) {
        $("#" + map.getTarget()).hide();
    };

    var showMap = function(map) {
        $("#" + map.getTarget()).show();
    };

    var clearLayers = function(map) {
        var activeLayers = map.getLayers().getArray().slice(0);
        _.each(activeLayers, function(mapLayer) {
            if ( mapLayer.wv ) {
                map.removeLayer(mapLayer);
            }
        });
        removeGraticule();
        //cache.clear();
    };

    var reloadLayers = function(map) {
        map = map || self.selected;
        clearLayers(map);

        var defs = models.layers.get({reverse: true});
        _.each(defs, function(def) {
            if ( isGraticule(def) )
                addGraticule();
            else
                self.selected.addLayer(createLayer(def));
        });
        updateLayerVisibilities();
    };

    var updateLayerVisibilities = function() {
        self.selected.getLayers().forEach(function(layer) {
            if ( layer.wv )
                layer.setVisible(models.layers.isRenderable(layer.wv.id));

        });
        var defs = models.layers.get();
        _.each(defs, function(def) {
            if ( isGraticule(def) ) {
                if ( models.layers.isRenderable(def.id) )
                    addGraticule();
                else
                    removeGraticule();
            }
        });
    };

    var updateOpacity = function(def, value) {
        var layer = findLayer(def);
        layer.setOpacity(value);
        updateLayerVisibilities();
    };

    var addLayer = function(def) {
        var mapIndex = _.findIndex(models.layers.get({reverse: true}), {
            id: def.id
        });
        if ( isGraticule(def) ) {
            addGraticule();
        } else {
            var layer = createLayer(def);
            self.selected.getLayers().insertAt(mapIndex, layer);
        }
        updateLayerVisibilities();
    };

    var removeLayer = function(def) {
        if ( isGraticule(def) ) {
            removeGraticule();
        } else {
            var layer = findLayer(def);
            self.selected.removeLayer(layer);
        }
        updateLayerVisibilities();
    };

    var updateLayerOrder = function() {
        reloadLayers();
    };

    var updateDate = function() {
        var defs = models.layers.get();
        _.each(defs, function(def) {
            if ( def.period !== "daily" ) {
                return;
            }
            var index = findLayerIndex(def);
            self.selected.getLayers().setAt(index, createLayer(def));
        });
        updateLayerVisibilities();
    };

    var updateLookup = function(layerId) {
        // If the lookup changes, all layers in the cache are now stale
        // since the tiles need to be rerendered. Remove from cache.
        var selectedDate = wv.util.toISOStringDate(models.date.selected);
        var selectedProj = models.proj.selected.id;
        cache.removeWhere(function(key, mapLayer) {
            return ( mapLayer.wvid === layerId &&
                 mapLayer.wvproj === selectedProj &&
                 mapLayer.wvdate !== selectedDate &&
                 mapLayer.lookupTable );
        });
        reloadLayers();
    };

    self.preload = function(date) {
        var layers = models.layers.get({
            renderable: true,
            dynamic: true
        });
        _.each(layers, function(def) {
            var key = layerKey(def, {date: date});
            var layer = cache.getItem(key);
            if ( !layer ) {
                layer = createLayer(def, {date: date});
            }
        });
    };

    var findLayer = function(def) {
        var layers = self.selected.getLayers().getArray();
        return _.find(layers, { wv: { id: def.id } });
    };

    var findLayerIndex = function(def) {
        var layers = self.selected.getLayers().getArray();
        return _.findIndex(layers, { wv: { id: def.id } });
    };

    var createLayer = function(def, options) {
        options = options || {};
        var key = layerKey(def, options);
        var layer = cache.getItem(key);
        if ( !layer ) {
            var proj = models.proj.selected;
            def = _.cloneDeep(def);
            _.merge(def, def.projections[proj.id]);
            if ( def.type === "wmts" ) {
                layer = createLayerWMTS(def, options);
            } else if ( def.type === "wms" ) {
                layer = createLayerWMS(def, options);
            } else {
                throw new Error("Unknown layer type: " + def.type);
            }
            var date = options.date || models.date.selected;
            layer.wv = {
                id: def.id,
                key: key,
                date: wv.util.toISOStringDate(date),
                proj: proj.id,
                def: def
            };
            if(!(animating() && !def.visible)) //For animations, the cache is not big enough, so cache only visible items
                cache.setItem(key, layer);
            layer.setVisible(false);
        }
        layer.setOpacity(def.opacity || 1.0);
        return layer;
    };

    var createLayerWMTS = function(def, options) {
        var proj = models.proj.selected;
        var source = config.sources[def.source];
        if ( !source ) {
            throw new Error(def.id + ": Invalid source: " + def.source);
        }
        var matrixSet = source.matrixSets[def.matrixSet];
        if ( !matrixSet ) {
            throw new Error(def.id + ": Undefined matrix set: " + def.matrixSet);
        }
        var matrixIds = [];
        _.each(matrixSet.resolutions, function(resolution, index) {
            matrixIds.push(index);
        });
        var extra = "";
        if ( def.period === "daily" ) {
            var date = options.date || models.date.selected;
            extra = "?TIME=" + wv.util.toISOStringDate(date);
        }
        var sourceOptions = {
            url: source.url + extra,
            layer: def.layer || def.id,
            format: def.format,
            matrixSet: matrixSet.id,
            tileGrid: new ol.tilegrid.WMTS({
                origin: [proj.maxExtent[0], proj.maxExtent[3]],
                resolutions: matrixSet.resolutions,
                matrixIds: matrixIds,
                tileSize: matrixSet.tileSize[0]
            }),
            wrapX: false
        };
        if ( models.palettes.isActive(def.id) ) {
            var lookup = models.palettes.get(def.id).lookup;
            sourceOptions.tileClass = ol.wv.LookupImageTile.factory(lookup);
        }
        return new ol.layer.Tile({
            source: new ol.source.WMTS(sourceOptions)
        });
    };

    var createLayerWMS = function(def, options) {
        var proj = models.proj.selected;
        var source = config.sources[def.source];
        if ( !source )
            throw new Error(def.id + ": Invalid source: " + def.source);

        var transparent = ( def.format === "image/png" );
        var parameters = {
            LAYERS: def.layer || def.id,
            FORMAT: def.format,
            TRANSPARENT: transparent,
            VERSION: "1.1.1"
        };
        if ( def.styles )
            parameters.STYLES = def.styles;

        var extra = "";
        if ( def.period === "daily" ) {
            var date = options.date || models.date.selected;
            extra = "?TIME=" + wv.util.toISOStringDate(date);
        }
        return new ol.layer.Tile({
            source: new ol.source.TileWMS({
                url: source.url + extra,
                params: parameters,
                tileGrid: new ol.tilegrid.TileGrid({
                    origin: [proj.maxExtent[0], proj.maxExtent[3]],
                    resolutions: proj.resolutions,
                    tileSize: 512
                })
            })
        });
    };

    var isGraticule = function(def) {
        var proj = models.proj.selected.id;
        return ( def.projections[proj].type === "graticule" ||
            def.type === "graticule" );
    };

    var addGraticule = function() {
        if ( self.selected.graticule )
            return;

        self.selected.graticule = new ol.Graticule({
            map: self.selected,
            strokeStyle: new ol.style.Stroke({
                color: 'rgba(255, 255, 255, 0.5)',
                width: 2,
                lineDash: [0.5, 4]
            })
        });
    };

    var removeGraticule = function() {
        if ( self.selected.graticule )
            self.selected.graticule.setMap(null);

        self.selected.graticule = null;
    };

    var triggerExtent = _.throttle(function() {
        self.events.trigger("extent");
    }, 500, { trailing: true });

    //Called as event listener when map is zoomed or panned
    var updateExtent = function() {
        var map = self.selected;
        models.map.update(map.getView().calculateExtent(map.getSize()));
        triggerExtent();
    };

    //Called as event listener when map is rotated. Update url to reflect rotation reset
    self.updateRotation = function() {
        models.map.rotation = self.selected.getView().getRotation();
        window.history.replaceState("", "@OFFICIAL_NAME@","?" + models.link.toQueryString());
        var rotation_sel = $(".wv-map-reset-rotation");

        //Set reset button content and proper CSS styling to position it correctly
        rotation_sel.button("option", "label", Number((models.map.rotation) * (180.0 / Math.PI)).toFixed() );
        if((models.map.rotation) * (180.0 / Math.PI) >= 100.0)
            rotation_sel.find("span").attr("style","padding-left: 9px");
        else if((models.map.rotation) * (180.0 / Math.PI) <= -100.0)
            rotation_sel.find("span").attr("style","padding-left: 6px");
        else if((models.map.rotation) * (180.0 / Math.PI) <= -10.0)
            rotation_sel.find("span").attr("style","padding-left: 10px");
        else
            rotation_sel.find("span").attr("style","padding-left: 14px");
    };

    var createMap = function(proj) {
        var id = "wv-map-" + proj.id;
        var $map = $("<div></div>")
            .attr("id", id)
            .attr("data-proj", proj.id)
            .addClass("wv-map")
            .hide();
        $(selector).append($map);

        //Create two specific controls
        var scaleMetric = new ol.control.ScaleLine({
            className: "wv-map-scale-metric",
            units: "metric"
        });
        var scaleImperial = new ol.control.ScaleLine({
            className: "wv-map-scale-imperial",
            units: "imperial"
        });

        //insert this to polar map views for desktop and mobile rotation
        var rotateInteraction = new ol.interaction.DragRotate({
            condition: ol.events.condition.altKeyOnly,
            duration: animationDuration
        }), mobileRotation = new ol.interaction.PinchRotate({
            duration: animationDuration
        });

        var map = new ol.Map({
            view: new ol.View({
                maxResolution: proj.resolutions[0],
                projection: ol.proj.get(proj.crs),
                extent: proj.maxExtent,
                center: proj.startCenter,
                rotation: proj.id === "geographic" ? 0.0 : models.map.rotation,
                zoom: proj.startZoom,
                maxZoom: proj.numZoomLevels,
                enableRotation: true
            }),
            target: id,
            renderer: ["canvas", "dom"],
            logo: false,
            controls: [
                scaleMetric,
                scaleImperial
            ],
            interactions: [
                new ol.interaction.DoubleClickZoom({
                    duration: animationDuration
                }),
                new ol.interaction.DragPan({
                    kinetic: new ol.Kinetic(-0.005, 0.05, 100)
                }),
                new ol.interaction.PinchZoom({
                    duration: animationDuration
                }),
                new ol.interaction.MouseWheelZoom({
                    duration: animationDuration
                }),
                new ol.interaction.DragZoom({
                    duration: animationDuration
                })
            ]
        });
        map.wv = {
            small: false,
            scaleMetric: scaleMetric,
            scaleImperial: scaleImperial
        };
        createZoomButtons(map, proj);
        createMousePosSel(map, proj);

        //allow rotation by dragging for polar projections
        if(proj.id !== 'geographic') {
            createRotationWidget(map);
            map.addInteraction(rotateInteraction);
            map.addInteraction(mobileRotation);
        }

        //Set event listeners for changes on the map view (when rotated, zoomed, panned)
        map.getView().on("change:center", updateExtent);
        map.getView().on("change:resolution", updateExtent);
        map.getView().on("change:rotation", self.updateRotation);

        return map;
    };

    var createZoomButtons = function(map, proj) {
        var $map = $("#" + map.getTarget());

        var $zoomOut = $("<button></button>")
            .addClass("wv-map-zoom-out wv-map-zoom");
        var $outIcon = $("<i></i>")
            .addClass("fa fa-minus fa-1x");
        $zoomOut.append($outIcon);
        $map.append($zoomOut);
        $zoomOut.button({
            text: false
        });
        $zoomOut.click(zoomAction(map, -1));

        var $zoomIn = $("<button></button>")
            .addClass("wv-map-zoom-in wv-map-zoom");
        var $inIcon = $("<i></i>")
            .addClass("fa fa-plus fa-1x");
        $zoomIn.append($inIcon);
        $map.append($zoomIn);
        $zoomIn.button({
            text: false
        });
        $zoomIn.click(zoomAction(map, 1));

        var onZoomChange = function() {
            var maxZoom = proj.resolutions.length;
            var zoom = map.getView().getZoom();
            if ( zoom === 0 ) {
                $zoomIn.button("enable");
                $zoomOut.button("disable");
            } else if ( zoom === maxZoom ) {
                $zoomIn.button("disable");
                $zoomOut.button("enable");
            } else {
                $zoomIn.button("enable");
                $zoomOut.button("enable");
            }
        };

        map.getView().on("change:resolution", onZoomChange);
        onZoomChange();
    };

    var createMousePosSel = function(map, proj) {
        var $map = $("#" + map.getTarget());
        map = map || self.selected;
        var mapId = 'coords-' + proj.id;

        var $mousePosition = $('<div></div>')
            .attr("id", mapId)
            .addClass("wv-coords-map wv-coords-map-btn");

        var coordinateFormat = function(source, format) {
            if ( !source ) {
                return "";
            }
            var target = ol.proj.transform(source, proj.crs, "EPSG:4326");
            var crs = ( models.proj.change ) ? models.proj.change.crs
                : models.proj.selected.crs;

            return wv.util.formatCoordinate(target, format) + " " + crs;
        };

        $map.append($mousePosition);

        var $latlonDD = $("<span></span>")
            .attr('id', mapId + '-latlon-dd')
            .attr('data-format', 'latlon-dd')
            .addClass('map-coord');
        var $latlonDMS = $("<span></span>")
            .attr('id', mapId + '-latlon-dms')
            .attr('data-format', 'latlon-dms')
            .addClass('map-coord');


        if ( wv.util.getCoordinateFormat() === "latlon-dd" ) {
            $('div.map-coord').removeClass('latlon-selected');
            $latlonDD.addClass('latlon-selected');
        } else {
            $('div.map-coord').removeClass('latlon-selected');
            $latlonDMS.addClass('latlon-selected');
        }
        var $coordBtn = $("<i></i>")
            .addClass('coord-switch');

        var $coordWrapper = $("<div></div>")
            .addClass('coord-btn');

        $coordWrapper.append($coordBtn);
        $mousePosition
            .append($latlonDD)
            .append($latlonDMS)
            .append($coordWrapper)
            .click(function() {
                var $format = $(this).find(".latlon-selected");

                if($format.attr("data-format") === "latlon-dd"){
                    $('span.map-coord').removeClass('latlon-selected');
                    $('span.map-coord[data-format="latlon-dms"]').addClass('latlon-selected');
                    wv.util.setCoordinateFormat('latlon-dms');
                }
                else{
                    $('span.map-coord').removeClass('latlon-selected');
                    $('span.map-coord[data-format="latlon-dd"]').addClass('latlon-selected');
                    wv.util.setCoordinateFormat('latlon-dd');
                }

            });

        $("#" + map.getTarget() + '>div')
            .mouseover(function(){
                $('#' + mapId).show();
            })
            .mouseout(function(){
                $('#' + mapId).hide();
            })
            .mousemove(function(e){
                $('#' + mapId).show();
                var coords = map.getCoordinateFromPixel([e.pageX,e.pageY]);
                $('#' + mapId + ' span.map-coord').each(function(){
                    var format = $(this).attr('data-format');
                    $(this).html(coordinateFormat(coords, format));
                });
            });
    };

    //Create rotation buttons for polar views
    var createRotationWidget = function(map) {
        var $map = $("#" + map.getTarget());

        var $left = $("<button></button>")
            .addClass("wv-map-rotate-left wv-map-zoom")
                .attr("title","You may also rotate by holding Alt and dragging the mouse"),
            $lefticon = $("<i></i>")
                .addClass("fa fa-undo");

        var $right = $("<button></button>")
            .addClass("wv-map-rotate-right wv-map-zoom")
            .attr("title","You may also rotate by holding Alt and dragging the mouse"),
            $righticon = $("<i></i>")
                .addClass("fa fa-repeat");

        var $mid = $("<button></button>")
            .addClass("wv-map-reset-rotation wv-map-zoom")
            .attr("title", "Click to reset");

        $left.append($lefticon); $right.append($righticon);
        $map.append($left).append($mid).append($right);

        var intervalId, dur = 500;

        //Set buttons to animate rotation by 18 degrees. use setInterval to repeat the rotation when mouse button is held
        $left.button({
            text: false
        }).mousedown(function() {
            rotate(10, dur);
            intervalId = setInterval(function() {
                rotate(10, dur);
            }, dur);
        }).mouseup(function() {
            clearInterval(intervalId);
        });

        $right.button({
            text: false
        }).mousedown(function() {
            rotate(-10, dur);
            intervalId = setInterval(function() {
                rotate(-10, dur);
            }, dur);
        }).mouseup(function() {
            clearInterval(intervalId);
        });

        $mid.button({
            label: Number(models.map.rotation * (180/Math.PI)).toFixed()
        }).mousedown(function() { //reset rotation
            clearInterval(intervalId); //stop repeating rotation on mobile
            map.beforeRender(ol.animation.rotate({
                duration: 500,
                rotation: map.getView().getRotation()
            }));
            map.getView().rotate(0);
            self.updateRotation();

            $mid.button("option", "label", "0");
        });

        //Function to rotate polar map tile when button is pressed. Amount divides a 180 degree rotation
        var rotate = function(amount, duration) {
            map.beforeRender(ol.animation.rotate({
                duration: duration,
                rotation: map.getView().getRotation()
            }));

            map.getView().rotate(map.getView().getRotation() - (Math.PI / amount));
            self.updateRotation();
        };

    };

    var zoomAction = function(map, amount) {
        return function() {
            var zoom = map.getView().getZoom();
            map.beforeRender(ol.animation.zoom({
                resolution: map.getView().getResolution(),
                duration: animationDuration
            }));
            map.getView().setZoom(zoom + amount);
        };
    };

    var layerKey = function(def, options) {
        var layerId = def.id;
        var projId = models.proj.selected.id;
        var date;
        if ( options.date ) {
            date = wv.util.toISOStringDate(options.date);
        } else {
            date = wv.util.toISOStringDate(models.date.selected);
        }
        var dateId = ( def.period === "daily" ) ? date : "";
        var palette = "";
        if ( models.palettes.isActive(def.id) ) {
            palette = models.palettes.key(def.id);
        }
        return [layerId, projId, dateId, palette].join(":");
    };

    //Check if an animation is on session, or whether the animation state exists
    var animating = function() {
        if(ui.anim === undefined)
            return false;
        return ui.anim.doAnimation;
    };

    init();
    return self;

};

