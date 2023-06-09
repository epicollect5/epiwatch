import { Device } from '@capacitor/device';
import { App } from '@capacitor/app';
import { databaseSelectService } from '@/services/database/database-select-service';
import { databaseMigrateService } from '@/services/database/database-migrate-service';
import { databaseDeleteService } from '@/services/database/database-delete-service';
import { databaseInsertService } from '@/services/database/database-insert-service';
import { utilsService } from '@/services/utilities/utils-service';
import { useRootStore } from '@/stores/root-store';
import { useDBStore } from '@/stores/db-store';
import { PARAMETERS, MIGRATIONS, DEMO_PROJECT } from '@/config';
import { STRINGS } from '@/config/strings';
import axios from 'axios';

export const initService = {

    async getDeviceInfo () {
        const deviceInfo = await Device.getInfo();
        const deviceId = await Device.getId();

        //switch to PWA mode based on environment
        if (deviceInfo.platform === PARAMETERS.WEB) {
            if (process.env.VUE_APP_MODE.toLowerCase() === PARAMETERS.PWA.toLowerCase()) {
                deviceInfo.platform = PARAMETERS.PWA;
            }
        }

        return { ...deviceInfo, ...deviceId };
    },

    async getAppInfo () {
        const rootStore = useRootStore();
        if ([PARAMETERS.WEB, PARAMETERS.PWA].includes(rootStore.device.platform)) {
            return {
                name: 'Epiwatch',
                version: 'n/a'
            };
        }
        return await App.getInfo();
    },

    async openDB (platform) {
        return new Promise((resolve) => {
            let db = {};

            if (platform === PARAMETERS.WEB) {
                db = window.openDatabase('epicollect5.db', '1.0', 'epicollect5', 5000000);
                resolve(db);
            }
            else {
                document.addEventListener('deviceready', () => {
                    console.log('deviceready called');

                    if (platform === PARAMETERS.ANDROID) {
                        db = window.sqlitePlugin.openDatabase({
                            name: 'epicollect5.db',
                            location: 'default',
                            androidDatabaseProvider: 'system',
                            androidLockWorkaround: 1//to be tested if this makes problems
                        });
                        resolve(db);
                    }

                    if (platform === PARAMETERS.IOS) {
                        db = window.sqlitePlugin.openDatabase({
                            name: 'epicollect5.db',
                            iosDatabaseLocation: 'Documents'
                        });
                        resolve(db);
                    }
                });
            }
        });
    },

    async getDBVersion () {

        let version;

        return new Promise((resolve, reject) => {
            databaseSelectService.selectSetting('db_version').then((res) => {

                if (res.rows.length > 0) {
                    version = res.rows.item(0).value;
                }
                resolve(version);
            }, (error) => {
                reject(error);
            });
        });
    },

    async migrateDB () {
        /**
        * Migrating altering tables, depending on stored version against latest version
        * See: http://stackoverflow.com/questions/989558/best-practices-for-in-app-database-migration-for-sqlite
        */
        // Get the db version from the database
        const dbStore = useDBStore();
        let dbVersion = dbStore.dbVersion;
        // Check if it doesn't exist
        if (!dbVersion) {
            // Set version as initial, to run through all alter table cases
            dbVersion = 1;
        } else if (dbVersion >= MIGRATIONS.db_version) {
            // Check if the version is not lower than the current version
            // todo: not sure what this does?
            // return $q.when([]);
        }

        // Alter the table if either there is no version set, or if the version is lower than the latest
        return new Promise((resolve, reject) => {
            databaseMigrateService.execute(dbVersion).then((nextVersion) => {
                // Warn user
                //NotificationService.showToast(STRINGS[$rootStore.language].labels.db_updated);
                // console.log(STRINGS[$rootStore.language].labels.db_updated);
                resolve(nextVersion);
            }, (error) => {
                reject(error);
            });
        });
    },

    async getLanguage () {
        let deviceLanguage = useRootStore().language;

        return new Promise((resolve, reject) => {

            if (navigator.globalization) {
                navigator.globalization.getPreferredLanguage(
                    function (language) {

                        //if the language translation exists, load it:

                        //Italian?
                        if (language.value.toLowerCase().startsWith('it')) {
                            deviceLanguage = 'it';
                        }
                        //Spanish?
                        if (language.value.toLowerCase().startsWith('es')) {
                            deviceLanguage = 'es';
                        }

                        //French?
                        if (language.value.toLowerCase().startsWith('fr')) {
                            deviceLanguage = 'fr';
                        }

                        //Polish?
                        if (language.value.toLowerCase().startsWith('pl')) {
                            deviceLanguage = 'pl';
                        }

                        //if language not supported, default to English
                        _getLanguageFile(deviceLanguage);

                        console.log('language: ' + language.value + '\n');
                    }, () => {
                        console.log('Error getting language');
                    }
                );
            }
            else {
                _getLanguageFile(deviceLanguage);
            }

            function _getLanguageFile (language) {
                //get status codes files (json) from public folder
                axios('./assets/ec5-status-codes/' + language + '.json')
                    .then((data) => {
                        STRINGS[language].status_codes = data.data;
                        resolve(language);
                    }, () => {
                        // Default to 'en' file
                        axios('./assets/ec5-status-codes/en.json').then((data) => {
                            STRINGS.en.status_codes = data.data;
                            resolve(language);
                        });
                    });
            }
        });
    },

    async getLanguagePWA () {

        const rootStore = useRootStore();
        const language = rootStore.language;
        const serverUrl = rootStore.serverUrl;
        let url = '/';

        return new Promise((resolve, reject) => {
            if (process.env.NODE_ENV === 'production') {
                //get the language files from data-editor folder in laravel
                const endpoint = PARAMETERS.PWA_LANGUAGE_FILES_ENDPOINT;
                url = serverUrl + endpoint + language + '.json';
            }
            else {
                //development i.e debugging pwa in the browser
                //get language file from local assets
                url = './assets/ec5-status-codes/' + language + '.json';
            }

            axios(url)
                .then((data) => {
                    STRINGS[language].status_codes = data.data;
                    resolve(language);
                }).catch((error) => {
                    console.log(error);
                });
        });
    },

    //Get the server url from the database, or default to ec5 production site
    async getServerUrl () {
        return new Promise((resolve, reject) => {
            databaseSelectService.selectSetting('server_url').then(function (res) {
                if (res.rows.length > 0 && res.rows.item(0).value !== '') {
                    resolve(res.rows.item(0).value);
                } else {
                    resolve(PARAMETERS.DEFAULT_SERVER_URL);
                }
                resolve();
            }, function (error) {
                reject(error);
            });
        });
    },

    //clear temporary tables
    async tidyTempTables () {

        return new Promise((resolve, reject) => {
            databaseDeleteService.deleteTempBranchEntries().then(() => {
                databaseDeleteService.deleteTempUniqueAnswers().then(() => {
                    resolve();
                }, (error) => {
                    reject(error);
                });
            }, (error) => {
                reject(error);
            });
        });
    },

    //Get the default order for displaying entries
    async getEntriesOrder () {

        return new Promise((resolve, reject) => {

            databaseSelectService.selectSetting('order_by').then(function (res) {

                // Update rootscope
                if (res.rows.length > 0) {
                    resolve(JSON.parse(res.rows.item(0).value));
                }
                else {
                    resolve(null);
                }
            }, function (error) {
                reject(error);
            });
        });
    },

    // Insert ec5 demo project
    async insertDemoProject () {

        function _getDemoProjectFromLocalFile (filename) {
            return new Promise((resolve) => {
                axios(filename + '?' + utilsService.generateTimestamp())
                    .then((data) => {
                        resolve(JSON.stringify(data));
                    });
            });
        }

        return new Promise((resolve, reject) => {
            //insert the demo project only on first install
            if (!window.localStorage.is_app_already_installed) {

                _getDemoProjectFromLocalFile(DEMO_PROJECT.PROJECT_FILENAME).then((response) => {

                    //just the "data" content, not the whole response

                    //Make changes for epiwatch app
                    const meta = utilsService.epiwatchifyProject(response);
                    DEMO_PROJECT.PROJECT_EXTRA = JSON.stringify(meta.project_extra);
                    DEMO_PROJECT.MAPPING = JSON.stringify(meta.project_mapping);
                    //get project vesrion from file
                    DEMO_PROJECT.LAST_UPDATED = meta.project_stats.structure_last_updated;

                    databaseInsertService.insertProject(
                        DEMO_PROJECT.PROJECT_SLUG,
                        DEMO_PROJECT.PROJECT_NAME,
                        DEMO_PROJECT.PROJECT_REF,
                        DEMO_PROJECT.PROJECT_EXTRA,
                        PARAMETERS.DEFAULT_SERVER_URL,
                        DEMO_PROJECT.LAST_UPDATED,
                        DEMO_PROJECT.MAPPING
                    ).then((res) => {
                        resolve();
                    }, (error) => {
                        reject(error);
                    });
                });
            } else {
                console.log('---App already installed -> skip demo project creation');
                resolve();
            }
        });
    },

    //Get the selected text size from database
    async getSelectedTextSize () {

        let selectedTextSize = PARAMETERS.DEFAULT_TEXT_SIZE;

        return new Promise((resolve, reject) => {
            databaseSelectService.selectSetting('selected_text_size').then(function (res) {

                if (res.rows.length > 0 && res.rows.item(0).value !== '0') {
                    selectedTextSize = res.rows.item(0).value;
                }
                resolve(selectedTextSize);
            }, function (error) {
                reject(error);
            });
        });
    },

    async getFiltersToggleStatus () {
        return new Promise(function (resolve, reject) {
            databaseSelectService.selectSetting('filters_toggle').then(function (res) {
                resolve(res.rows.length > 0 && res.rows.item(0).value === 'true');
            }, function (error) {
                reject(error);
            });
        });
    },

    async retrieveJwtToken () {
        const rootStore = useRootStore();
        return new Promise(function (resolve, reject) {
            databaseSelectService.getUser().then(async function (response) {

                const user = {};
                // Get the db version from the database
                const language = rootStore.language;

                // Set JWT into rootscope
                user.jwt = '';
                user.name = '';
                user.email = '';

                // Check if we have one
                if (response.rows.length > 0) {
                    // If we do, then the action is to 'logout'
                    user.action = STRINGS[language].labels.logout;
                    // Set JWT into rootscope
                    user.jwt = response.rows.item(0).jwt;
                    // Set User name into rootscope

                    user.name = response.rows.item(0).name;
                    user.email = response.rows.item(0).email;

                } else {
                    // Default action to 'login'
                    user.action = STRINGS[language].labels.login;
                }

                resolve(user);
            });
        });
    }
};