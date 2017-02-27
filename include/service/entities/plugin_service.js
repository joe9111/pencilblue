/*
 Copyright (C) 2016  PencilBlue, LLC

 This program is free software: you can redistribute it and/or modify
 it under the terms of the GNU General Public License as published by
 the Free Software Foundation, either version 3 of the License, or
 (at your option) any later version.

 This program is distributed in the hope that it will be useful,
 but WITHOUT ANY WARRANTY; without even the implied warranty of
 MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 GNU General Public License for more details.

 You should have received a copy of the GNU General Public License
 along with this program.  If not, see <http://www.gnu.org/licenses/>.
 */
'use strict';

//dependencies
const _ = require('lodash');
const ArrayUtils = require('../../../lib/utils/array_utils');
const async   = require('async');
const CacheEntityService = require('../cache_entity_service');
const CommandService = require('../../system/command/command_service');
const Configuration = require('../../config');
const DAO = require('../../dao/dao');
const DbEntityService = require('../db_entity_service');
const domain  = require('domain');
const FileUtils = require('../../../lib/utils/fileUtils');
const fs      = require('fs');
const log = require('../../utils/logging').newInstance('PluginService');
const MemoryEntityService = require('../memory_entity_service');
const npm     = require('npm');
const NpmPluginDependencyService = require('./plugins/npm_plugin_dependency_service');
const path    = require('path');
const PluginAvailableJob = require('../jobs/plugins/plugin_available_job');
const PluginDependenciesJob = require('../jobs/plugins/plugin_dependencies_job');
const PluginDependencyService = require('./plugins/bower_plugin_dependency_service');
const PluginInitializeJob = require('../jobs/plugins/plugin_initialize_job');
const PluginInitializationService = require('./plugins/plugin_initialization_service');
const PluginInstallJob = require('../jobs/plugins/plugin_install_job');
const PluginLocalizationLoader = require('./plugins/loaders/plugin_localization_loader');
const PluginRepository = require('../../repository/plugin_repository');
const PluginServiceLoader = require('./plugins/loaders/plugin_service_loader');
const PluginSettingService = require('./plugin_setting_service');
const PluginUninstallJob = require('../jobs/plugins/plugin_uninstall_job');
const PluginUtils = require('../../../lib/utils/pluginUtils');
const PluginValidationService = require('./plugins/plugin_validation_service');
const semver = require('semver');
const SettingServiceFactory = require('../../system/settings');
const SimpleLayeredService = require('../simple_layered_service');
const SiteQueryService = require('./site_query_service');
const SiteService = require('./site_service');
const SiteUtils = require('../../../lib/utils/siteUtils');
const TaskUtils = require('../../../lib/utils/taskUtils');
const util = require('util');
const UrlUtils = require('../../../lib/utils/urlUtils');
const ValidationService = require('../../validation/validation_service');

/**
 * PluginService - Provides functions for interacting with plugins.
 * Install/uninstall, setting retrieval, plugin retrieval, etc.
 *
 * @class PluginService
 * @constructor
 * @param {Object} options
 * @param {String} [options.site]
 * @module Services
 * @submodule Entities
 */
class PluginService {
    constructor(options) {
        if (!_.isObject(options)) {
            options = {};
        }

        /**
         * @property site
         * @type {String}
         */
        this.site = options.site || SiteUtils.GLOBAL_SITE;

        /**
         * @property _pluginRepository
         * @type {PluginRepository}
         */
        this._pluginRepository = PluginRepository;

        //construct settings services
        var caching = Configuration.active.plugins.caching;

        /**
         * A setting service that sets and retrieves the settings for plugins
         * @property pluginSettingsService
         * @type {SimpleLayeredService}
         */
        this.pluginSettingsService = PluginService.genSettingsService('plugin_settings', caching.use_memory, caching.use_cache, 'PluginSettingService', this.site);

        /**
         * A setting service that sets and retrieves the settings for plugins
         * @property pluginSettingsService
         * @type {SimpleLayeredService}
         */
        this.themeSettingsService = PluginService.genSettingsService('theme_settings', caching.use_memory, caching.use_cache, 'ThemeSettingService', this.site);
    }

    // Constants
    /**
     * The absolute path to the plugins directory for this PecilBlue installation
     * @property PLUGINS_DIR
     * @type {String}
     */
    static get PLUGINS_DIR() {
        return path.join(Configuration.active.docRoot, 'plugins');
    }

    /**
     * The name of the file that defines the plugin's properties
     * @property DETAILS_FILE_NAME
     * @type {String}
     */
    static get DETAILS_FILE_NAME() {
        return 'details.json';
    }

    /**
     * The name of the directory for each plugin that contains the public resources
     * @property PUBLIC_DIR_NAME
     * @type {String}
     */
    static get PUBLIC_DIR_NAME() {
        return 'public';
    }

    // Statics


    /**
     * Retrieves the path to the active fav icon.
     * @method getActiveIcon
     * @param {Function} cb A callback that provides two parameters: cb(Error, URL_PATH_TO_ICON)
     */
    getActiveIcon(cb) {
        var self = this;
        var settings = SettingServiceFactory.getService(Configuration.active.settings.use_memory, Configuration.active.settings.use_cache, this.site);
        settings.get('active_theme', function (err, theme) {
            var active_theme = PluginService.getPluginForSite(theme, self.site);
            cb(err, active_theme && active_theme.icon ? active_theme.icon : '/favicon.ico');
        });
    }

    /**
     * Remove the active plugin entry from the current PB process.
     * NOTE: it is not recommended to call this directly.
     * @static
     * @method deactivatePlugin
     * @param {String} pluginUid
     * @param {string} site
     * @return {Boolean}
     */
    static deactivatePlugin(pluginUid, site) {
        if (!ValidationService.isNonEmptyStr(pluginUid)) {
            throw new Error('A non-existent or empty plugin UID was passed');
        }

        if (!site) {
            site = SiteUtils.GLOBAL_SITE;
        }

        if (ACTIVE_PLUGINS[site] && ACTIVE_PLUGINS[site][pluginUid]) {
            delete ACTIVE_PLUGINS[site][pluginUid];
            return true;
        }
        return false;
    }

    /**
     * Activates a plugin based on the UID and the provided spec
     * @static
     * @method activatePlugin
     * @param {string} pluginUid
     * @param {object} pluginSpec
     * @param {function} pluginSpec.main_module
     * @param {string} pluginSpec.public_dir
     * @param {object} pluginSpec.permissions
     * @param {Array} pluginSpec.templates
     * @param {string} pluginSpec.icon
     * @param {object} pluginSpec.services
     * @param {string} site
     * @returns {boolean} TRUE if the site is set as active and FALSE when the site is already active
     */
    static activatePlugin(pluginUid, pluginSpec, site) {
        if (ACTIVE_PLUGINS[site] && ACTIVE_PLUGINS[site][pluginUid]) {
            return false;
        }
        if (!ACTIVE_PLUGINS[site]) {
            ACTIVE_PLUGINS[site] = {};
        }
        ACTIVE_PLUGINS[site][pluginUid] = pluginSpec;
        return true;
    }

    /**
     * Retrieves the main module prototype for the specified active plugin
     * @static
     * @method getActiveMainModule
     * @param {String} pluginUid
     * @param {string} site
     * @return {Function} The prototype that is the plugin's main module.
     */
    static getActiveMainModule(pluginUid, site) {
        if (!site) {
            site = SiteUtils.GLOBAL_SITE;
        }
        return (ACTIVE_PLUGINS[site] && ACTIVE_PLUGINS[site][pluginUid]) ? ACTIVE_PLUGINS[site][pluginUid].main_module : null;
    }

    /**
     * Retrieves the names of the active plugins for this instance
     * @method getActivePluginNames
     * @return {array} An array that contain the names of the plugins that
     * initialized successfully within this instance.
     */
    getActivePluginNames() {
        var globalPlugins = [];
        if (ACTIVE_PLUGINS[SiteUtils.GLOBAL_SITE]) {
            globalPlugins = Object.keys(ACTIVE_PLUGINS[SiteUtils.GLOBAL_SITE]);
        }
        var sitePlugins = [];
        if (ACTIVE_PLUGINS[this.site]) {
            sitePlugins = Object.keys(ACTIVE_PLUGINS[this.site]);
        }
        return _.uniq(sitePlugins.concat(globalPlugins));
    }

    /**
     * Get a array of active plugin names with site name as a prefix: site_name_plugin_name
     * @method getAllActivePluginNames
     * @return {Array} array of active plugin names with site name prefix.
     */
    getAllActivePluginNames() {
        var pluginNames = [];
        var siteNames = Object.keys(ACTIVE_PLUGINS);
        for (var i = 0; i < siteNames.length; i++) {
            var sitePluginNames = Object.keys(ACTIVE_PLUGINS[siteNames[i]]);
            for (var j = 0; j < sitePluginNames.length; j++) {
                pluginNames.push(siteNames[i] + '_' + sitePluginNames[j]);
            }
        }
        return pluginNames;
    }

    /**
     * Retrieves a single setting for the specified plugin.
     * @method getSetting
     * @param {string} settingName The name of the setting to retrieve
     * @param {string} pluginName The name of the plugin who owns the setting
     * @param {function} cb A callback that provides two parameters: cb(error, settingValue).
     * Null is returned if the setting does not exist or the specified plugin is not
     * installed.
     */
    getSetting(settingName, pluginName, cb) {
        var settingService = getPluginSettingService(this);
        settingService.getSetting(settingName, pluginName, cb);
    }

    /**
     * Retrieves all of the settings for the specfied plugin.
     * @method getSettings
     * @param pluginName The name of the plugin who's settings are being requested
     * @param cb A callback that provides two parameters: cb(error, settings).
     * Null is provided in the event that the plugin is not installed.
     */
    getSettings(pluginName, cb) {
        var settingService = getPluginSettingService(this);
        settingService.getSettings(pluginName, cb);
    }

    /**
     * Retrieves the settings for a plugin as hash of key/value pairs.  This
     * differs from the getSettings function because the getSettings function
     * provides the settings in their raw form as an array of objects containing
     * multiple properties.  In most circumstances just the k/v pair is needed and
     * not any additional information about the property.  The function takes the
     * raw settings array and transforms it into an object where the setting name
     * is the property and the setting value is the value.
     * @method getSettingsKV
     * @param {String} pluginName The unique ID of the plugin who settings are to be retrieved
     * @param {Function} cb A callback that takes two parameters.  A error, if
     * exists, and a hash of of the plugin's settings' names/values.
     */
    getSettingsKV(pluginName, cb) {
        var settingService = getPluginSettingService(this);
        settingService.getSettingsKV(pluginName, cb);
    }

    /**
     * Replaces a single setting for the specified plugin
     * @method setSetting
     * @param name The name of the setting to change
     * @param value The new value for the setting
     * @param pluginName The plugin who's setting is being changed.
     * @param cb A callback that provides two parameters: cb(error, TRUE/FALSE).
     * TRUE if the setting was persisted successfully, FALSE if not.
     */
    setSetting(name, value, pluginName, cb) {
        var settingService = getPluginSettingService(this);
        settingService.setSetting(name, value, pluginName, cb);
    }

    /**
     * Replaces the settings for the specified plugin.
     * @method setSettings
     * @param settings The settings object to be validated and persisted
     * @param pluginName The name of the plugin who's settings are being represented
     * @param cb A callback that provides two parameters: cb(error, TRUE/FALSE).
     * TRUE if the settings were persisted successfully, FALSE if not.
     */
    setSettings(settings, pluginName, cb) {
        var settingService = getPluginSettingService(this);
        settingService.setSettings(settings, pluginName, cb);
    }

    /**
     * Replaces a single theme setting for the specified plugin
     * @method setThemeSetting
     * @param name The name of the setting to change
     * @param value The new value for the setting
     * @param pluginName The plugin who's setting is being changed.
     * @param cb A callback that provides two parameters: cb(error, TRUE/FALSE).
     * TRUE if the setting was persisted successfully, FALSE if not.
     */
    setThemeSetting(name, value, pluginName, cb) {
        var settingService = getPluginSettingService(this);
        settingService.setThemeSetting(name, value, pluginName, cb);
    }

    /**
     * Replaces the theme settings for the specified plugin.
     * @method setThemeSettings
     * @param settings The settings object to be validated and persisted
     * @param pluginName The uid of the plugin who's settings are being represented
     * @param cb A callback that provides two parameters: cb(error, TRUE/FALSE).
     * TRUE if the settings were persisted successfully, FALSE if not.
     */
    setThemeSettings(settings, pluginName, cb) {
        var settingService = getPluginSettingService(this);
        settingService.setThemeSettings(settings, pluginName, cb);
    }

    /**
     * Retrieves a single theme setting value.
     * @method getThemeSetting
     * @param settingName The uid of the setting
     * @param pluginName The plugin to retrieve the setting from
     * @param cb A callback that provides two parameters: cb(error, settingValue)
     */
    getThemeSetting(settingName, pluginName, cb) {
        var settingService = getPluginSettingService(this);
        settingService.getThemeSetting(settingName, pluginName, cb);
    }

    /**
     * Retrieves the theme settings for the specified plugin
     * @method getThemeSettings
     * @param pluginName The uid of the plugin
     * @param cb A callback that provides two parameters: cb(err, settingsObject)
     */
    getThemeSettings(pluginName, cb) {
        var settingService = getPluginSettingService(this);
        settingService.getThemeSettings(pluginName, cb);
    }

    /**
     * Retrieves the theme settings for the specified plugin only for the site set in the current plugin service
     * @method getThemeSettingsBySite
     * @param pluginName
     * @param cb
     */
    getThemeSettingsBySite(pluginName, cb) {
        var settingService = getPluginSettingService(this);
        settingService.getThemeSettingsBySite(pluginName, cb);
    }

    /**
     * Retrieves the theme settings for a plugin as hash of key/value pairs.  This
     * differs from the getThemeSettings function because the getThemeSettings function
     * provides the settings in their raw form as an array of objects containing
     * multiple properties.  In most circumstances just the k/v pair is needed and
     * not any additional information about the property.  The function takes the
     * raw settings array and transforms it into an object where the setting name
     * is the property and the setting value is the value.
     * @method getThemeSettingsKV
     * @param {String} pluginName The unique ID of the plugin who settings are to be retrieved
     * @param {Function} cb A callback that takes two parameters.  A error, if
     * exists, and a hash of of the plugin's settings' names/values.
     */
    getThemeSettingsKV(pluginName, cb) {
        var settingService = getPluginSettingService(this);
        settingService.getThemeSettingsKV(pluginName, cb);
    }

    /**
     * Deletes the plugin settings for when plugin uninstalls.
     * @method purgePluginSettings
     * @param {String} pluginUid - the plugin unique id
     * @param {Function} cb - callback function
     */
    purgePluginSettings(pluginUid, cb) {
        var settingService = getPluginSettingService(this);
        settingService.purgePluginSettings(pluginUid, cb);
    }

    /**
     * Deletes the theme settings for when plugin uninstalls.
     * @method purgeThemeSettings
     * @param {String} pluginUid - the plugin unique id
     * @param {Function} cb - callback function
     */
    purgeThemeSettings(pluginUid, cb) {
        var settingService = getPluginSettingService(this);
        settingService.purgeThemeSettings(pluginUid, cb);
    }

    /**
     * Indicates if a plugin by the specified identifier is installed.
     *
     * @method isInstalled
     * @param {string} pluginIdentifier The identifier can either be an ObjectID or the
     * plugin name
     * @param cb A callback that provides two parameters: cb(error, TRUE/FALSE).
     * TRUE if the plugin is installed, FALSE if not.
     */
    isInstalled(pluginIdentifier, cb) {
        this.getPluginBySite(pluginIdentifier, function (err, plugin) {
            cb(err, plugin ? true : false);
        });
    }

    /**
     * Retrieves a plugin descriptor (plugin document)
     *
     * @method getPlugin
     * @param {string} pluginIdentifier The identifier can either be an ObjectID or the
     * plugin name
     * @param {Function} cb A callback that provides two parameters: cb(error, plugin).  If the
     * plugin does exist null is provided.
     */
    getPlugin(pluginIdentifier, cb) {
        this._pluginRepository.loadPluginAvailableToThisSite(pluginIdentifier, this.site, cb);
    }

    /**
     * @method getPluginBySite
     * @param {string} pluginIdentifier
     * @param {Function} cb
     */
    getPluginBySite(pluginIdentifier, cb) {
        this._pluginRepository.loadPluginOwnedByThisSite(pluginIdentifier, this.site, cb);
    }

    /**
     * Retrieves the plugins that have themes associated with them
     * @method getPluginsWithThemes
     * @param {Function} cb Provides two parameters: Error, Array
     */
    getPluginsWithThemes(cb) {
        this._pluginRepository.loadPluginsWithThemesAvailableToThisSite(this.site, cb);
    }

    /**
     * Get plugins that contain a theme on a site level.
     * @method getPluginsWithThemesBySite
     * @param {Function} cb - callback function
     */
    getPluginsWithThemesBySite(cb) {
        this._pluginRepository.loadPluginsWithThemesOwnedByThisSite(this.site, cb);
    }

    /**
     * Convenience function to generate a service to handle settings for a plugin.
     *
     * @static
     * @method genSettingsService
     * @param objType The type of object that will be dealt with.  (plugin_settings,
     * theme_settings)
     * @param useMemory {Boolean} Indicates if the generated layered service should
     * use an in memory service.
     * @param useCache {Boolean} Indicates if the generated layered service should
     * use a cache service.
     * @param serviceName The name of the service
     * @param {string} site
     * @return {SimpleLayeredService}
     */
    static genSettingsService(objType, useMemory, useCache, serviceName, site) {

        //add in-memory service
        var services = [];

        var options = {
            objType: objType,
            site: site,
            onlyThisSite: false,
            timeout: Configuration.active.plugins.caching.memory_timeout
        };

        if (useMemory) {
            services.push(new MemoryEntityService(options));
        }

        //add cache service
        if (useCache) {
            options.timeout = 3600;
            services.push(new CacheEntityService(options));
        }

        //always add DB
        options.keyField = 'plugin_uid';
        options.valueField = 'settings';
        services.push(new DbEntityService(options));
        return new SimpleLayeredService(services, serviceName);
    }

    /**
     * Compares the details loaded from the plugin config (details.json)
     * with the database values pulled from getSettingsKV(). If a discrepancy
     * is detected, the plugin settings are updated in the database so future
     * calls to getSettingsKV() will have the latest values.
     *
     * @method syncSettings
     * @param plugin {Object} The plugin object
     * @param details {Object} The details object to extract the settings from
     * @param cb A callback that provides two parameters: cb(error, TRUE/FALSE).
     * TRUE/FALSE if an error occured.
     */
    syncSettings(plugin, details, cb) {
        var self = this;
        this.getSettings(plugin.uid, function(err, settings) {
            var isError = _.isError(err);
            if (isError || !settings) {
                if (isError) {
                    log.error('Failed to load settings from plugin [%s]', plugin.uid);
                }
                return cb(err, !isError);
            }
            
            //create lookup
            settings = settings.reduce(function(rv, setting) {
                rv[setting.name] = setting;
                return rv;
            }, {});

            var discrepancy = false;
            var formattedSettings = [];

            // Detect new settings
            details.settings.forEach(function (setting) {
                var settingName = setting.name;
                var val = settings[settingName];
                if (typeof val === 'undefined') {
                    discrepancy = true;
                    val = setting.value;
                    formattedSettings.push({name: settingName, value: val, displayName: setting.displayName, group: setting.group});
                }
                else {
                    if(setting.group !== val.group){
                        val.group = setting.group;
                        discrepancy = true;
                    }
                    else if(settings.displayName !== val.displayName){
                        val.displayName = setting.displayName;
                        discrepancy = true;
                    }
		            formattedSettings.push(val);
                }
            });

            // If there's a size difference, there's a discrepancy
            discrepancy = discrepancy || (details.settings.length !== Object.keys(settings).length);

            // Return if no discrepancy was found
            if (!discrepancy) {
                return cb(null, true);
            }

            self.resetSettings({uid: plugin.uid, settings: formattedSettings}, function (err/*, result*/) {
                if (_.isError(err)) {
                    log.error("PluginService: Failed to save off updated settings for plugin [%s]", plugin.uid);
                }
                cb(err, !_.isError(err));
            });
        });
    }

    /**
     * Loads the settings from a details object and persists them in the DB.  Any
     * existing settings for the plugin are deleted before the new settings are
     * persisted.
     *
     * @method resetSettings
     * @param details The details object to extract the settings from
     * @param cb A callback that provides two parameters: cb(error, TRUE/FALSE).
     * TRUE if the settings were successfully cleared and reloaded. FALSE if not.
     */
    resetSettings(details, cb) {
        var self = this;

        //retrieve plugin to prove it exists (plus we need the id)
        var pluginName = details.uid;
        this.getPlugin(pluginName, function (err, plugin) {
            if (_.isError(err) || !plugin) {
                return cb(err ? err : new Error("The plugin " + pluginName + " is not installed"), false);
            }

            //remove any existing settings
            self.pluginSettingsService.purge(pluginName, function (err, result) {
                if (_.isError(err) || !result) {
                    return cb(err, false);
                }

                //build the object to persist
                var baseDoc = {
                    plugin_name: plugin.name,
                    plugin_uid: plugin.uid,
                    plugin_id: plugin[DAO.getIdField()].toString(),
                    settings: details.settings
                };
                var settings = baseDoc;
                settings.object_type = 'plugin_settings';

                //save it
                var dao = new SiteQueryService({site: self.site});
                dao.save(settings, function (err/*, result*/) {
                    cb(err, !_.isError(err));
                });
            });
        });
    }

    /**
     * Loads the Theme settings from a details object and persists them in the DB.  Any
     * existing theme settings for the plugin are deleted before the new settings
     * are persisted. If the plugin does not have a theme then false is provided in
     * the callback.
     *
     * @method resetThemeSettings
     * @param details The details object to extract the settings from
     * @param cb A callback that provides two parameters: cb(error, TRUE/FALSE).
     * TRUE if the settings were successfully cleared and reloaded. FALSE if not.
     */
    resetThemeSettings (details, cb) {
        var self = this;

        //error checking
        var pluginName = details.uid;
        if (!details.theme || !details.theme.settings) {
            cb(new Error("PluginService: Settings are required when attempting to reset a plugin's theme settings"), false);
            return;
        }

        //retrieve plugin to prove it exists (plus we need the id)
        this.getPlugin(pluginName, function (err, plugin) {
            if (_.isError(err) || !plugin) {
                cb(err, false);
                return;
            }

            //remove any existing settings
            self.themeSettingsService.purge(pluginName, function (err, result) {
                if (_.isError(err) || !result) {
                    cb(err, false);
                    return;
                }

                //build the object to persist
                var baseDoc = {
                    plugin_name: plugin.name,
                    plugin_uid: plugin.uid,
                    plugin_id: plugin[DAO.getIdField()].toString(),
                    settings: details.theme.settings
                };
                var settings = baseDoc;
                settings.object_type = 'theme_settings';

                //save it
                var dao = new SiteQueryService({site: self.site});
                dao.save(settings, function (err/*, result*/) {
                    cb(err, !_.isError(err));
                });
            });
        });
    }

    /**
     * Retrieves the permission set for a given role.  All active plugins are
     * inspected.
     * @static
     * @method getPermissionsForRole
     * @param {string} role The role to get permissions for
     * @return {Object} A hash of the permissions
     */
    static getPermissionsForRole(role) {
        var perms = {};
        Object.keys(ACTIVE_PLUGINS).forEach(function (site) {
            Object.keys(ACTIVE_PLUGINS[site]).forEach(function (pluginUid) {
                var permissions = ACTIVE_PLUGINS[site][pluginUid].permissions;
                if (permissions) {

                    var permsAtLevel = permissions[role];
                    if (permsAtLevel) {
                        Object.assign(perms, permsAtLevel);
                    }
                }
            });
        });

        return perms;
    }

    /**
     * Retrieves the file path to the public directory for the specified plugin.
     * @static
     * @method getActivePluginDir
     * @param {String} pluginUid A plugin's UID value
     * @return {String} File path to the plugin's public directory
     */
    static getActivePluginPublicDir(pluginUid) {
        var publicPath = null;
        var keys = Object.keys(ACTIVE_PLUGINS);
        for (var i = 0; i < keys.length; i++) {
            if (ACTIVE_PLUGINS[keys[i]][pluginUid]) {
                publicPath = ACTIVE_PLUGINS[keys[i]][pluginUid].public_dir;
                break;
            }
        }
        return publicPath;
    }

    /**
     * Indicates if the specified plugin is active in this instance of PB.
     * @static
     * @method isActivePlugin
     * @param {String} uid The unique identifier for a plugin
     * @param {string} site
     * @return {Boolean} TRUE if the plugin is active, FALSE if not
     */
    static isActivePlugin(uid, site) {
        if (!site) {
            site = SiteUtils.GLOBAL_SITE;
        }
        return !!PluginService.getPluginForSite(uid, site);
    }

    /**
     *
     * @param theme
     * @param site
     * @returns {*}
     */
    static getPluginForSite(theme, site) {
        if (ACTIVE_PLUGINS[site] && ACTIVE_PLUGINS[site][theme]) {
            return ACTIVE_PLUGINS[site][theme];
        } else if (ACTIVE_PLUGINS[SiteUtils.GLOBAL_SITE] && ACTIVE_PLUGINS[SiteUtils.GLOBAL_SITE][theme]) {
            return ACTIVE_PLUGINS[SiteUtils.GLOBAL_SITE][theme];
        }
        return null;
    }

    /**
     * Indicates if the specified plugin is active for a given site in this instance of PB.
     * @static
     * @method isActivePlugin
     * @param {String} uid The unique identifier for a plugin
     * @param {string} site
     * @return {Boolean} TRUE if the plugin is active, FALSE if not
     */
    static isPluginActiveBySite(uid, site) {
        if (!site) {
            site = SiteUtils.GLOBAL_SITE;
        }
        return ACTIVE_PLUGINS[site] && ACTIVE_PLUGINS[site][uid];
    }

    /**
     * Generates a URL path to a public resource for a plugin.
     * @static
     * @method genPublicPath
     * @param {String} plugin The UID of the plugin
     * @param {String} relativePathToMedia The relative path to the resource from
     * the plugin's public directory.
     * @return {String} URL path to the resource
     */
    static genPublicPath(plugin, relativePathToMedia) {
        if (!_.isString(plugin) || !_.isString(relativePathToMedia)) {
            return '';
        }
        return UrlUtils.urlJoin('/public', plugin, relativePathToMedia);
    }

    /**
     * Retrieves the details for the active plugins.
     * @method getActivePlugins
     * @param {Function} cb A callback that provides two parameters: cb(Error, Array)
     */
    getActivePlugins(cb) {
        this._pluginRepository.loadIncludedPluginsOwnedByThisSite(this.getActivePluginNames(), this.site, cb);
    }

    /**
     * Retrieves the content templates for all of the active plugins
     * @static
     * @method getActiveContentTemplates
     * @param targetSite
     * @return {Array} An array of objects
     */
    static getActiveContentTemplates(targetSite) {

        var templates = [];
        Object.keys(ACTIVE_PLUGINS).forEach(function (site) {
            if (!SiteService.isNotSetOrEqual(targetSite, site)) {
                return;
            }
            var pluginsForSite = ACTIVE_PLUGINS[site];
            Object.keys(pluginsForSite).forEach(function (uid) {
                var plugin = pluginsForSite[uid];
                if (plugin.templates) {
                    var clone = _.clone(plugin.templates);
                    for (var i = 0; i < clone.length; i++) {
                        clone[i].theme_uid = uid;
                        templates.push(clone[i]);
                    }
                }
            });
        });
        return templates;
    }

    /**
     * Retrieves the inactive plugins for this instance of PencilBlue.  An inactive
     * plugin is considered one who failed to install or one that failed to start
     * properly.
     * @method getInactivePlugins
     * @param {Function} cb A callback that provides two parameters: cb(Error, Array)
     */
    getInactivePlugins(cb) {
        this._pluginRepository.loadPluginsNotIncludedOwnedByThisSite(this.getActivePluginNames(), this.site, cb);
    }

    /**
     * Retrieves the available plugins.  An available plugin is one who is
     * uninstalled but available to be installed.
     * @method getAvailablePlugins
     * @param {Array} active An array of plugin detail objects.  Each object is
     * required to have a uid property that is a string.
     * @param {Array} inactive An array of plugin details objects. Each object is
     * required to have a uid property that is a string.
     * @param {Function} cb A callback that provides two parameters: cb(Error, Array)
     */
    getAvailablePlugins(active, inactive, cb) {
        if (Array.isArray(active)) {
            active = ArrayUtils.toObject(active, function(val) {
                return val ? val.uid : '';
            });
        }
        if (Array.isArray(inactive)) {
            inactive = ArrayUtils.toObject(inactive, function(val) {
                return val ? val.uid : '';
            });
        }

        FileUtils.getDirectories(PluginUtils.PLUGINS_DIR).catch(cb).then(function (directories) {

            var plugins = [];
            var tasks = directories.map(function (directory, i, directories) {
                return function (callback) {

                    //skip pencilblue
                    var parts = directories[i].split(path.sep);
                    var dirName = parts[parts.length - 1];
                    if (dirName === Configuration.active.plugins.default) {
                        callback(null, true);
                        return;
                    }

                    var detailsFilePath = path.join(directories[i], PluginService.DETAILS_FILE_NAME);
                    PluginService.loadDetailsFile(detailsFilePath, function (err, details) {
                        if (_.isError(err)) {
                            plugins.push({
                                uid: dirName,
                                dirName: dirName,
                                description: "Failed to load & parse the details.json file.",
                                validationErrors: ['An invalid details file was provided for plugin. ' + err.stack]
                            });
                            callback(null, false);
                            return;
                        }

                        PluginService.validateDetails(details, dirName, function (err/*, result*/) {
                            if (_.isError(err)) {
                                plugins.push({
                                    uid: dirName,
                                    dirName: dirName,
                                    version: details.version,
                                    description: "The plugin details file failed validation ",
                                    validationErrors: err.validationErrors
                                });
                                callback(null, false);
                                return;
                            }
                            else if ((active && active[details.uid]) || (inactive && inactive[details.uid])) {
                                callback(null, true);
                                return;
                            }
                            details.dirName = dirName;
                            plugins.push(details);
                            callback(null, true);
                        });
                    });
                };
            });
            async.series(tasks, function (err/*, results*/) {
                cb(err, plugins);
            });
        });
    }

    /**
     * Retrieves a map of the system's plugin.  The map provides three properties:
     * active, inactive, available.
     * @method getPluginMap
     * @param {Function} cb A callback that provides two parameters: cb(Error, Object)
     */
    getPluginMap(cb) {
        var self = this;
        var tasks = {

            active: function (callback) {
                self.getActivePlugins(callback);
            },

            inactive: function (callback) {
                self.getInactivePlugins(callback);
            }
        };
        async.series(tasks, function (err, results) {
            if (_.isError(err)) {
                cb(err, results);
                return;
            }

            self.getAvailablePlugins(results.active, results.inactive, function (err, available) {
                results.available = available;
                cb(err, results);
            });
        });
    }

    /**
     * Uninstalls the plugin with the specified UID.
     * @method uninstallPlugin
     * @param {String} pluginUid The unique plugin identifier
     * @param {Object} [options]
     * @param {String} [options.jobId] Required when uninstalling from the executing
     * process instead of calling upon the cluster.
     * @param {Boolean} [options.forCluster=true] When true or not provided the function
     * instructs the cluster to uninstall the plugin.  When explicitly FALSE the
     * function installs the plugin from the executing process.
     * @param {Function} cb A callback that provides two parameters: cb(Error, Boolean)
     */
    uninstallPlugin(pluginUid, options, cb) {
        if (_.isFunction(options)) {
            cb = options;
            options = {};
        }
        if (!_.isObject(options)) {
            options = {};
        }
        if (!_.isFunction(cb)) {
            cb = function(){};
        }

        //log start of operation
        if (log.isDebug()) {
            log.debug("PluginService:[%s] Attempting uninstall with options: %s", pluginUid, util.inspect(options));
        }


        var name = util.format('UNINSTALL_PLUGIN_%s', pluginUid);
        var jobId = options.jobId;
        var site = this.site;
        var job = new PluginUninstallJob();
        job.init(name, jobId);
        job.setPluginUid(pluginUid);
        job.setSite(site);
        job.setRunAsInitiator(options.forCluster !== false);
        job.run(cb);
        return job.getId();
    }

    /**
     * Installs a plugin by stepping through a series of steps that must be
     * completed in order.  There is currently no fallback plan for a failed install.
     * In order for a plugin to be fully installed it must perform the following
     * actions without error:
     * <ol>
     * <li>Load and parse the plugin's details.json file</li>
     * <li>Pass validation</li>
     * <li>Must not already be installed</li>
     * <li>Successfully register itself with the system</li>
     * <li>Successfully load any plugin settings</li>
     * <li>Successfully load any theme settings</li>
     * <li>Successfully execute the plugin's onInstall function</li>
     * <li>Successfully initialize the plugin for runtime</li>
     * </ol>
     * @method installPlugin
     * @param {string} pluginDirName The name of the directory that contains the
     * plugin and its details.json file.
     * @param {function} [cb] A callback that provides two parameters: cb(err, TRUE/FALSE)
     * @return {String} The job ID
     */
    installPlugin(pluginDirName, cb) {

        cb = cb || function(){};
        var name = util.format('INSTALL_PLUGIN_%s', pluginDirName);
        var job = new PluginInstallJob();
        job.init(name);
        job.setRunAsInitiator(true);
        job.setSite(this.site);
        job.setPluginUid(pluginDirName);
        job.run(cb);
        return job.getId();
    }

    /**
     * Attempts to initialize all installed plugins.
     * @method initPlugins
     * @param {Function} cb A callback that provides two parameters: cb(Error, Boolean)
     */
    initPlugins(cb) {
        log.debug('PluginService: Beginning plugin initialization...');

        var self = this;
        async.waterfall([
            TaskUtils.wrapTask(this._pluginRepository, this._pluginRepository.loadPluginsAcrossAllSites),
            function (plugins, callback) {
                if (plugins.length === 0) {
                    log.debug('PluginService: No plugins are installed');
                    return callback(null, []);
                }
                var tasks = plugins.map(function (plugin, i, plugins) {
                    return function (callback) {

                        try {
                            self.initPlugin(plugins[i], function (err, didInitialize) {
                                callback(null, {plugin: plugins[i], error: err, initialized: didInitialize});
                            });
                        }
                        catch (err) {
                            callback(null, {plugin: plugins[i], error: err, initialized: false});
                        }
                    };
                });
                async.series(tasks, callback);
            }
        ], cb);
    }

    /**
     * Initializes a plugin during startup or just after a plugin has been installed.
     * @method initPlugin
     * @param {object} plugin The plugin details
     * @param {function} cb A callback that provides two parameters: cb(Error, Boolean)
     */
    initPlugin(plugin, cb) {
        if (typeof plugin !== 'object') {
            return cb(new Error('PluginService:[INIT] The plugin object must be passed in order to initialize the plugin'), null);
        }

        var service = new pb.PluginInitializationService({
            pluginService: this.site === plugin.site ? this : new PluginService({ site: plugin.site }),
            pluginCache: PLUGIN_INIT_CACHE
        });
        service.initialize(plugin, {}, function (err, result) {
            PLUGIN_INIT_CACHE = {};
            cb(err, result);
        });
    }

    /**
     * Verifies that a plugin has all of the required dependencies installed from NPM
     * @method hasDependencies
     * @param {Object} plugin
     * @param {Function} cb
     */
    hasDependencies(plugin, cb) {
        var npmPluginDependencyService = new NpmPluginDependencyService();
        npmPluginDependencyService.hasDependencies(plugin, {}, cb);
    }

    /**
     * Installs the dependencies for a plugin via NPM.
     * @method installPluginDependencies
     * @param {String} pluginDirName
     * @param {Object} dependencies
     * @param {Object} plugin
     * @param {Function} cb
     */
    installPluginDependencies(pluginDirName, dependencies, plugin, cb) {

        //verify parameters
        if (!ValidationService.isNonEmptyStr(pluginDirName, true) || !_.isObject(dependencies)) {
            return cb(new Error('The plugin directory name and the dependencies are required'));
        }

        var npmDependencyService = new NpmPluginDependencyService();
        npmDependencyService.installAll(plugin, {}, cb);
    }

    /**
     * Loads a module dependencies for the specified plugin.
     * @deprecated
     * @static
     * @method require
     * @param {String} pluginDirName
     * @param {String} moduleName
     * @return {*} The entity returned by the "require" call.
     */
    static require(pluginDirName, moduleName) {
        log.warn('PluginService: require is deprecated. Use NpmPluginDependencyService.require');
        return NpmPluginDependencyService.require(pluginDirName, moduleName);
    }

    /**
     * Loads the localization files from the specified plugin directory and places
     * them into a hash where the key is the name of the localization file.
     * @deprecated since 0.6.0
     * @method getLocalizations
     * @param {String} pluginDirName The name of the plugin directory
     * @param {Function} cb A callback that provides two parameters: cb(Error, Object).
     * When the directory does not exist NULL is returned as the result parameter.
     */
    getLocalizations(pluginDirName, cb) {
        var service = new PluginLocalizationLoader({pluginUid: pluginDirName, site: this.site});
        service.getAll({}, cb);
    }

    /**
     * Retrieves a plugin service prototype.  It is expected to be a prototype but
     * it may also be an instance as along as that instance fulfills all
     * responsibilities of the service interface.  When the desired service does not
     * exist NULL is returned.
     * @deprecated
     * @method getService
     * @param {String} serviceName
     * @param {String} pluginUid The unique plugin identifier
     * @param {string} site
     * @return {Object} Service prototype
     */
    getService(serviceName, pluginUid, site) {
        log.warn('PluginService: Instance function getService is deprecated. Use pb.PluginService.getService instead: plugin:' + pluginUid + ' service:' + serviceName);
        try {
            return PluginService.getService(serviceName, pluginUid, site);
        }
        catch (e) {
            //for backward compatibility until the function is removed
            return null;
        }
    }

    /**
     * Retrieves a plugin service prototype.  It is expected to be a prototype but
     * it may also be an instance as along as that instance fulfills all
     * responsibilities of the service interface.  When the desired service does not
     * exist NULL is returned.
     * @static
     * @method getService
     * @param {String} serviceName
     * @param {String} pluginUid The unique plugin identifier
     * @param {string} [site=global] - The site UID
     * @return {Object} Service prototype
     */
    static getService(serviceName, pluginUid, site) {
        if (!site) {
            site = SiteUtils.GLOBAL_SITE;
        }
        if (ACTIVE_PLUGINS[site] && ACTIVE_PLUGINS[site][pluginUid]) {
            if (ACTIVE_PLUGINS[site][pluginUid].services && ACTIVE_PLUGINS[site][pluginUid].services[serviceName]) {
                return ACTIVE_PLUGINS[site][pluginUid].services[serviceName];
            }
        } else if (ACTIVE_PLUGINS[SiteUtils.GLOBAL_SITE] && ACTIVE_PLUGINS[SiteUtils.GLOBAL_SITE][pluginUid]) {
            if (ACTIVE_PLUGINS[SiteUtils.GLOBAL_SITE][pluginUid].services && ACTIVE_PLUGINS[SiteUtils.GLOBAL_SITE][pluginUid].services[serviceName]) {
                return ACTIVE_PLUGINS[SiteUtils.GLOBAL_SITE][pluginUid].services[serviceName];
            }
        }
        throw new Error('Either plugin [' + pluginUid + '] or the service [' + serviceName + '] does not exist for site [' + site + ']');
    }

    /**
     * Attempts to require the main module file for a plugin.
     * @static
     * @method loadMainModule
     * @param {String} pluginDirName The name of the directory that the plugin is
     * contained within.
     * @param {String} pathToModule The name of the main module file.  It is also
     * to pass this parameter as the absolute file path to the module.  The
     * function first checks if the parameter is just the file name then checks to
     * see if it is an absolute path.
     * @return {Function} The main-module prototype
     */
    static loadMainModule(pluginDirName, pathToModule) {
        var pluginMM = path.join(PluginService.PLUGINS_DIR, pluginDirName, pathToModule);
        var paths = [pluginMM, pathToModule];

        var mainModule = null;
        for (var i = 0; i < paths.length; i++) {
            try {
                mainModule = require(paths[i]);
                break;
            }
            catch (e) {
                if (log.isDebug()) {
                    log.warn('PluginService: Failed to load main module at %s: %s', paths[i], e.stack);
                }
            }
        }
        return mainModule;
    }

    /**
     * Constructs the path to a specific plugin's details.json file
     * @static
     * @method getDetailsPath
     * @param {String} pluginDirName The name of the directory that the plugin is
     * contained within.
     * @return {string} The absolute file path to the details.json file for a plugin
     */
    static getDetailsPath(pluginDirName) {
        return path.join(PluginService.PLUGINS_DIR, pluginDirName, PluginService.DETAILS_FILE_NAME);
    }

    /**
     * Attempts to load and parse the details.json file for a plugin.
     * @static
     * @method loadDetailsFile
     * @param {String} filePath The absolute path to the details.json file
     * @param {Function} cb A callback that provides two parameters: cb(error, detailsObject)
     */
    static loadDetailsFile(filePath, cb) {
        fs.readFile(filePath, function (err, data) {
            if (_.isError(err)) {
                cb(err, null);
                return;
            }

            //attempt to parse the json
            try {
                cb(null, JSON.parse(data));
            }
            catch (e) {
                e.message = "Failed to parse json file [" + filePath + ']. ' + e.message;
                e.code = 500;
                e.source = e;
                cb(e, null);
            }
        });
    }

    /**
     * Validates a plugin's details.json file.
     * @deprecated
     * @static
     * @method validateDetails
     * @param {object} details The details object to validate
     * @param {object} [details.theme]
     * @param {object} details.permissions
     * @param {string} details.uid
     * @param {string} details.description
     * @param {string} details.version
     * @param {string} details.pb_version
     * @param {string} details.icon
     * @param {Array} [details.contributors]
     * @param {object} [details.author]
     * @param {Array} [details.settings]
     * @param {String} pluginDirName The name of the directory containing the original
     * details.json file that the details object was derived from.
     * @param {Function} cb A callback that provides two parameters: cb(error, TRUE/FALSE).
     * TRUE if the details object passes validation, FALSE if not.
     */
    static validateDetails(details, pluginDirName, cb) {
        if (!_.isObject(details)) {
            cb(new Error("Details cannot be null and must be an object"), false);
            return;
        }

        var validationService = new PluginValidationService({});
        validationService.validate(details, {}, function (err, validationErrors) {
            if (_.isError(err)) {
                return cb(err);
            }

            //check for validation error
            validationErrors = validationErrors || [];
            if (validationErrors.length > 0) {
                err = new Error("Failed to validate plugin details");
                err.validationErrors = validationErrors;
            }
            cb(err, validationErrors.length === 0);
        });
    }

    /**
     * Validates the path to the plugin's icon file.  The path is considered valid
     * if the path to a valid file.  The path may be absolute or relative to the
     * plugin's public directory.
     * @deprecated
     * @static
     * @method validateIconPath
     * @param iconPath The path to the icon (image) file
     * @param pluginDirName The name of the directory housing the plugin
     * @return {Boolean} TRUE if the path is valid, FALSE if not
     */
    static validateIconPath(iconPath, pluginDirName) {
        return PluginValidationService.validateIconPath(iconPath, pluginDirName);
    }

    /**
     * Validates the path of a main module file.  The path is considered valid if
     * the path points to JS file.  The path may be absolute or relative to the
     * specific plugin directory.
     * @deprecated
     * @static
     * @method validateMainModulePath
     * @param mmPath The relative or absolute path to the main module file
     * @param pluginDirName The name of the directory housing the plugin
     * @return {Boolean} TRUE if the path is valid, FALSE if not
     */
    static validateMainModulePath(mmPath, pluginDirName) {
        return PluginValidationService.validateMainModulePath(mmPath, pluginDirName);
    }

    /**
     * Validates a setting from a details.json file.
     * @deprecated
     * @method validateSetting
     * @param setting The setting to validate
     * @param position The position in the settings array where the setting resides
     * as a 0 based index.
     * @return {Array} The array of errors that were generated.  If no errors were
     * produced an empty array is returned.
     */
    static validateSetting(setting, position) {

        //setup
        var errors = [];

        //validate object
        if (_.isObject(setting)) {

            //validate name
            if (!ValidationService.isNonEmptyStr(setting.name, true)) {
                errors.push(new Error("The setting name at position " + position + " must be provided"));
            }

            //validate value
            if (!PluginDependencyService.validateSettingValue(setting.value)) {
                errors.push(new Error("The setting value at position " + position + " must be provided"));
            }
        }
        else {
            errors.push(new Error("The setting value at position " + position + " must be an object"));
        }

        return errors;
    }

    /**
     * Retrieves all services (initialized).  The services are provided in the
     * callback.
     * @deprecated
     * @static
     * @method getServices
     * @param {String} pathToPlugin The absolute file path to the specific plugin directory.
     * @param {Function} cb A callback that provides two parameters: cb(error, servicesHash);
     */
    static getServices(pathToPlugin, cb) {
        log.warn('PluginService: getServices is deprecated. Use PluginServiceLoader.getAll');

        var pathParts = pathToPlugin.split(path.sep);

        var service = new PluginServiceLoader({pluginUid: pathParts[pathParts.length - 1]});
        service.getAll({}, cb);
    }

    /**
     * Loads a plugin service and initializes it.  The service is required to
     * implement an "init" function. The service is then provided as a parameter in
     * the callback.
     * @deprecated
     * @static
     * @method loadService
     * @param {String} pathToService The absolute file path to the service javascript file.
     * @param {Function} cb A callback that provides two parameters: cb(error, initializedService)
     */
    static loadService(pathToService, cb) {
        log.warn('PluginService: loadService is deprecated. Use PluginServiceLoader.get');

        var service = new PluginServiceLoader({});
        service.get(pathToService, function (err, serviceWrapper) {
            if (serviceWrapper) {
                serviceWrapper = serviceWrapper.service;
            }
            cb(err, serviceWrapper);
        });
    }

    /**
     * Derives the name of a plugin service instance.  The function attempts to get
     * the name of the service by looking to see if the service has implemented the
     * getName function.  If it has not then the service name is set to be the file
     * name minus any extension.
     * @deprecated since 0.6.0
     * @static
     * @method getServiceName
     * @param pathToService The file path to the service
     * @param service The service prototype
     * @return {String} The derived service name
     */
    static getServiceName(pathToService, service) {
        log.warn('PluginService: getServiceName is deprecated. Use PluginServiceLoader.getServiceName');
        PluginServiceLoader.getServiceName(pathToService, service);
    }

    /**
     * <b>NOTE: DO NOT CALL THIS DIRECTLY</b><br/>
     * The function is called when a command is recevied to uninstall a plugin.
     * The function builds out the appropriate options then calls the
     * uninstallPlugin function.  The result is then sent back to the calling
     * process via the CommandService.
     * @static
     * @method onUninstallPluginCommandReceived
     * @param {Object} command
     * @param {String} command.jobId The ID of the in-progress job that this
     * process is intended to join.
     */
    static onUninstallPluginCommandReceived(command) {
        if (!_.isObject(command)) {
            log.error('PluginService: an invalid uninstall plugin command object was passed. %s', util.inspect(command));
            return;
        }

        var options = {
            forCluster: false,
            jobId: command.jobId
        };

        var pluginService = new PluginService({site: command.site});
        pluginService.uninstallPlugin(command.pluginUid, options, function (err, result) {

            var response = {
                error: err ? err.stack : undefined,
                result: result
            };
            CommandService.getInstance().sendInResponseTo(command, response);
        });
    }

    /**
     * <b>NOTE: DO NOT CALL THIS DIRECTLY</b><br/>
     * The function is called when a command is recevied to validate that a plugin is available to this process for install.
     * The function builds out the appropriate options then calls the
     * uninstallPlugin function.  The result is then sent back to the calling
     * process via the CommandService.
     * @static
     * @method onIsPluginAvailableCommandReceived
     * @param {Object} command
     * @param {String} command.jobId The ID of the in-progress job that this
     * process is intended to join.
     */
    static onIsPluginAvailableCommandReceived(command) {
        if (!_.isObject(command)) {
            log.error('PluginService: an invalid is_plugin_available command object was passed. %s', util.inspect(command));
            return;
        }

        var name = util.format("IS_AVAILABLE_%s", command.pluginUid);
        var job = new PluginAvailableJob();
        job.setRunAsInitiator(false)
            .init(name, command.jobId)
            .setPluginUid(command.pluginUid)
            .run(function (err, result) {

                var response = {
                    error: err ? err.stack : undefined,
                    result: result ? true : false
                };
                CommandService.getInstance().sendInResponseTo(command, response);
            });
    }

    /**
     * <b>NOTE: DO NOT CALL THIS DIRECTLY</b><br/>
     * The function is called when a command is recevied to install plugin
     * dependencies.  The result is then sent back to the calling process via the
     * CommandService.
     * @static
     * @method onIsPluginAvailableCommandReceived
     * @param {Object} command
     * @param {String} command.jobId The ID of the in-progress job that this
     * process is intended to join.
     */
    static onInstallPluginDependenciesCommandReceived(command) {
        if (!_.isObject(command)) {
            log.error('PluginService: an invalid install_plugin_dependencies command object was passed. %s', util.inspect(command));
            return;
        }

        var name = util.format("INSTALL_DEPENDENCIES_%s", command.pluginUid);
        var job = new PluginDependenciesJob();
        job.setRunAsInitiator(false)
            .init(name, command.jobId)
            .setPluginUid(command.pluginUid)
            .run(function (err, result) {

                var response = {
                    error: err ? err.stack : undefined,
                    result: result ? true : false
                };
                CommandService.getInstance().sendInResponseTo(command, response);
            });
    }

    /**
     * <b>NOTE: DO NOT CALL THIS DIRECTLY</b><br/>
     * The function is called when a command is recevied to initialize a plugin.
     * The result is then sent back to the calling process via the
     * CommandService.
     * @static
     * @method onIsPluginAvailableCommandReceived
     * @param {Object} command
     * @param {String} command.jobId The ID of the in-progress job that this
     * process is intended to join.
     */
    static onInitializePluginCommandReceived(command) {
        if (!_.isObject(command)) {
            log.error('PluginService: an invalid initialize_plugin command object was passed. %s', util.inspect(command));
            return;
        }

        var name = util.format("INITIALIZE_PLUGIN_%s", command.pluginUid);
        var job = new PluginInitializeJob();
        job.setRunAsInitiator(false)
            .init(name, command.jobId)
            .setPluginUid(command.pluginUid)
            .setSite(command.site)
            .run(function (err, result) {

                var response = {
                    error: err ? err.stack : undefined,
                    result: result ? true : false
                };
                CommandService.getInstance().sendInResponseTo(command, response);
            });
    }

    /**
     *
     * @static
     * @method init
     */
    static init() {

        //register for commands
        var commandService = CommandService.getInstance();
        commandService.registerForType(PluginUninstallJob.UNINSTALL_PLUGIN_COMMAND, PluginService.onUninstallPluginCommandReceived);
        commandService.registerForType('is_plugin_available', PluginService.onIsPluginAvailableCommandReceived);
        commandService.registerForType('install_plugin_dependencies', PluginService.onInstallPluginDependenciesCommandReceived);
        commandService.registerForType('initialize_plugin', PluginService.onInitializePluginCommandReceived);
    }
}

    /**
     * A hash of the plugins that are installed and active in this instance of PB.
     * @property ACTIVE_PLUGINS
     * @type {Object}
     */
    var ACTIVE_PLUGINS = {};

    /**
     * A hash of shared plugin information used during plugin initialization
     * @property PLUGIN_INIT_CACHE;
     * @type {Object}
     */
    var PLUGIN_INIT_CACHE = {};

function getPluginSettingService(self) {
    if(!self.pluginSettingService) {
        self.pluginSettingService = new PluginSettingService({ pluginService: self });
    }
    return self.pluginSettingService;
}

//exports
module.exports = PluginService;
