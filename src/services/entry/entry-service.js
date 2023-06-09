import { PARAMETERS } from '@/config';
import { projectModel } from '@/models/project-model.js';
import { formModel } from '@/models/form-model.js';
import { entryModel } from '@/models/entry-model';
import { useRootStore } from '@/stores/root-store';
import { Capacitor } from '@capacitor/core';
import { toRaw } from 'vue';
import { databaseSelectService } from '@/services/database/database-select-service';
import { databaseInsertService } from '@/services/database/database-insert-service';
import { databaseDeleteService } from '@/services/database/database-delete-service';
import { databaseUpdateService } from '@/services/database/database-update-service';
import { utilsService } from '@/services/utilities/utils-service';
import { locationService } from '@/services/utilities/location-cordova-service';
import { entryCommonService } from '@/services/entry/entry-common-service';
import { mediaService } from '@/services/entry/media-service';
import { webService } from '@/services/web-service';
import { JSONTransformerService } from '@/services/utilities/json-transformer-service';
import { wasJumpEdited } from '@/use/questions/was-jump-edited';

export const entryService = {
    type: PARAMETERS.ENTRY,
    allowSave: true,
    form: {},
    entry: {},
    //Initial function to set up the entry
    setUpNew (formRef, parentEntryUuid, parentFormRef) {
        const rootStore = useRootStore();
        this.action = PARAMETERS.ENTRY_ADD;
        this.allowSave = true;
        this.form = formModel;
        this.entry = entryModel;

        // Initialise the entry model
        this.entry.initialise({
            entry_uuid: utilsService.uuid(),
            parent_entry_uuid: parentEntryUuid,
            form_ref: formRef,
            parent_form_ref: parentFormRef,
            answers: {},
            project_ref: projectModel.getProjectRef(),
            title: '',
            titles: [],
            is_remote: 0,
            synced: 2,
            synced_error: '',
            can_edit: 1,
            created_at: '',
            unique_answers: {}
        });

        // Set form details
        formModel.initialise(projectModel.getExtraForm(formRef));
        this.formIndex = projectModel.getFormIndex(formRef);
        this.formName = formModel.getName();
        this.form.inputs = projectModel.getFormInputs(formRef);

        // Watch device position only if the form has got a location input
        if (projectModel.hasLocation(formRef)) {
            if (Capacitor.isNativePlatform()) {
                // Start watching location
                rootStore.deviceGeolocation = {
                    ...rootStore.deviceGeolocation,
                    ...{
                        error: null,
                        position: null
                    }
                };

                console.log('asking for permission');
                locationService.requestLocationPermission();
            }
        }
    },

    // Initial function to set up the entry from an existing stored entry
    setUpExisting (entry) {

        console.log(JSON.stringify(entry));

        const self = this;
        const rootStore = useRootStore();
        self.form = formModel;
        self.entry = entryModel;

        return new Promise((resolve, reject) => {
            self.action = PARAMETERS.ENTRY_EDIT;
            self.allowSave = true;

            // Replace entry model object
            self.entry = entry;

            // Set form details
            formModel.initialise(projectModel.getExtraForm(self.entry.formRef));
            self.formIndex = projectModel.getFormIndex(self.entry.formRef);
            self.formName = formModel.getName();
            formModel.inputs = projectModel.getFormInputs(self.entry.formRef);

            // Watch device position only if the form has got a location input
            if (projectModel.hasLocation(self.entry.formRef)) {
                if (Capacitor.isNativePlatform()) {
                    if (rootStore.device.platform !== PARAMETERS.WEB) {
                        rootStore.deviceGeolocation = {
                            error: null,
                            position: null,
                            watchId: 0
                        };

                        locationService.requestLocationPermission();
                    }
                }
            }
            if (Capacitor.isNativePlatform()) {
                // This is a promise to be resolved BEFORE any directive is called
                mediaService.getEntryStoredMedia(self.entry.entryUuid).then(function (response) {
                    self.entry.media = response;
                    resolve();
                });
            } else {
                if (rootStore.isPWA) {
                    // This is a promise to be resolved BEFORE any directive is called
                    mediaService.getEntryStoredMediaPWA(self.entry.entryUuid).then(function (response) {
                        self.entry.media = response;
                        resolve();
                    });
                }
                else {
                    //on web debug media files are not available
                    self.entry.media = {};
                }
                resolve();
            }
        });
    },

    saveEntry (syncType) {

        const rootStore = useRootStore();
        const self = this;

        return new Promise((resolve, reject) => {
            // If this is an entry we can actually edit, i.e. not a remote entry
            if (self.entry.canEdit === 1) {
                // Set the entry title 
                entryCommonService.setEntryTitle(projectModel.getExtraForm(
                    self.entry.formRef),
                    projectModel.getExtraInputs(),
                    self.entry,
                    false
                );
            }

            function _onError (error) {
                console.log(error);
                reject(error);
            }

            //remove media files answers before saving the entry
            rootStore.queueFilesToDelete.forEach((file) => {
                //if we have a cached file, that will replace the one
                //we are deleting, so skip it
                if (file.filenameStored === self.entry.answers[file.inputRef].answer) {
                    self.entry.answers[file.inputRef].answer = '';
                }
            });

            console.log(self.entry);
            console.log(JSON.stringify(self.entry));

            // Unsync all parent entries
            this.unsyncParentEntries(projectModel.getProjectRef(), self.entry.parentEntryUuid).then(function () {

                // Save the entry in the database
                databaseInsertService.insertEntry(self.entry, syncType).then(function (res) {

                    // Insert any unique answers for this entry
                    databaseInsertService.insertUniqueAnswers(self.entry, false).then(function () {

                        // Next move over any branch entries from the temp table to the main table
                        databaseInsertService.moveBranchEntries(self.entry).then(function (res) {

                            // Move over temp unique answers (for branches) into unique answers table
                            databaseInsertService.moveUniqueAnswers().then(function (res) {

                                // If there are any media files for this entry, insert metadata into media table and save files
                                mediaService.saveMedia(self.entry, syncType).then(function () {
                                    console.log('All media files saved ***************************');
                                    resolve(res);
                                }, _onError);
                            }, _onError);
                        }, _onError);
                    }, _onError);
                }, _onError);
            });
        });
    },

    saveEntryPWA () {

        const rootStore = useRootStore();
        const self = this;

        //todo: check this, if we leave it we override changes when editing
        // self.form = formModel;
        // self.entry = entryModel;
        const projectSlug = projectModel.getSlug();
        let uploadErrors = [];
        //clear branch errors
        rootStore.queueBranchUploadErrorsPWA = {};
        rootStore.queueGlobalUploadErrorsPWA = [];
        async function uploadBranchEntriesSequential (branchEntries) {

            return new Promise((resolve) => {
                const branchEntry = branchEntries.pop();
                webService.uploadEntryPWA(projectSlug, branchEntry).then((response) => {

                    console.log('branch entry uploaded', response);
                    if (branchEntries.length > 0) {
                        resolve(uploadBranchEntriesSequential(branchEntries));
                    }
                    else {
                        resolve(uploadErrors);
                    }
                }, (error) => {
                    console.log({ branchEntry });
                    console.log('branch entry upload error', error);
                    console.log(error);

                    //attach branch uuid to errors so we can identify which
                    //branch entry failed and update UI
                    // (branchRef is the same for multiple entries so not enough)
                    //on pwa is needed, on native app we get it from the DB
                    const branchErrors = error.data.errors.map((branchError) => {
                        branchError.uuid = branchEntry.id;
                        return branchError;
                    });

                    //cache errors (DISTINCT)
                    uploadErrors = [...new Set([...uploadErrors, ...branchErrors])];
                    if (branchEntries.length > 0) {
                        resolve(uploadBranchEntriesSequential(branchEntries));
                    }
                    else {
                        //group branch errors by branch input ref (source)

                        rootStore.queueBranchUploadErrorsPWA = utilsService.arrayGroupBy(uploadErrors, (v) => { return v.source; });
                        //extract global errors

                        const inputsExtra = projectModel.getExtraInputs();
                        for (const [inpuRef, errors] of Object.entries(rootStore.queueBranchUploadErrorsPWA)) {
                            if (!inputsExtra[inpuRef]) {
                                rootStore.queueGlobalUploadErrorsPWA.push(...errors);
                            }
                        }

                        resolve(uploadErrors);
                    }
                });
            });
        }

        return new Promise((resolve, reject) => {

            // Set the entry title 
            entryCommonService.setEntryTitle(projectModel.getExtraForm(
                self.entry.formRef),
                projectModel.getExtraInputs(),
                self.entry,
                false
            );

            console.log(JSON.stringify(self.entry));

            //convert self.entry to an object identical to the one we save to the DB, 
            //so we can re-use all the functions
            const parsedEntry = {
                entry_uuid: self.entry.entryUuid,
                parent_entry_uuid: self.entry.parentEntryUuid,
                answers: JSON.stringify(self.entry.answers),
                form_ref: self.entry.formRef,
                parent_form_ref: self.entry.parentFormRef,
                created_at: utilsService.getISODateTime(),
                title: self.entry.title,
                synced: 0,
                can_edit: 1,
                is_remote: 0,
                last_updated: projectModel.getLastUpdated(),//<-- the project version
                device_id: '',
                platform: PARAMETERS.WEB,
                entry_type: PARAMETERS.ENTRY
            };

            //upload entry to server
            const uploadableEntry = JSONTransformerService.makeJsonEntry(PARAMETERS.ENTRY, parsedEntry);

            webService.uploadEntryPWA(projectSlug, uploadableEntry).then(async (response) => {
                //any branches to upload for this entry?
                const allBranchEntries = toRaw(rootStore.queueTempBranchEntriesPWA);
                if (Object.keys(allBranchEntries).length > 0) {
                    const branchEntries = [];
                    Object.values(allBranchEntries).forEach((questionBranchEntries) => {
                        questionBranchEntries.forEach(async (branchEntry) => {
                            console.log({ branchEntry });
                            branchEntries.push(branchEntry);
                        });
                    });

                    //imp: collect upload errors for branches
                    const branchUploadErrors = await uploadBranchEntriesSequential(branchEntries);

                    if (branchUploadErrors.length > 0) {
                        //remove uploaded temp branches, keep the failed only?
                        //rootStore.queueTempBranchEntriesPWA
                        reject({ data: { errors: branchUploadErrors } });
                    }
                    else {
                        resolve();
                        rootStore.queueTempBranchEntriesPWA = {};
                    }
                }
                else {
                    console.log(response);
                    resolve(response);
                }
            }, (error) => {
                console.log(error);
                if (error.data.errors) {
                    //add global errors (if any) to store
                    const inputsExtra = projectModel.getExtraInputs();
                    error.data.errors.forEach((error) => {
                        const inpuRef = error.source;
                        if (!inputsExtra[inpuRef]) {
                            //no inputRef, this is a global error
                            rootStore.queueGlobalUploadErrorsPWA.push(error);
                        }
                    });
                }
                reject(error);
            });
        });
    },

    getAnswers (inputRef) {
        return entryCommonService.getAnswers(this.entry, inputRef);
    },

    wasJumpEdited (params) {
        return wasJumpEdited(this, params);
    },

    //Validate and append answer/title to entry object
    validateAnswer (params) {
        //todo: test this throughly in the future...
        //For edits: check if all the required questions have an answer
        //Users can edit an existing entry, go back and save. 
        //The server would catch the missing required answer anyway
        // if (this.action === PARAMETERS.ENTRY_EDIT) {
        //     const inputs = projectModel.getExtraInputs();

        //     for (const [inputRef, answerObj] of Object.entries(this.entry.answers)) {
        //         if (inputs[inputRef].data.is_required === true) {
        //             if (answerObj.answer === '') {
        //                 this.allowSave = false;
        //                 break;
        //             }
        //         }
        //     }

        //    // console.log(this.entry);
        //     //console.log(params);
        // }
        return entryCommonService.validateAnswer(this.entry, params);
    },

    /**
     * Get the next input ref
     * Process the jumps
     * Set any answer 'was_jumped' properties to true/false
     */
    processJumpsNext (answer, inputDetails, currentInputIndex) {
        return entryCommonService.processJumpsNext(this.entry, answer, inputDetails, currentInputIndex, this.form.inputs);
    },

    /**
     * Get the previous input ref
     * Check for previous questions that were jumped
     */
    processJumpsPrevious (currentInputIndex) {
        return entryCommonService.processJumpsPrevious(this.entry, currentInputIndex, this.form.inputs);
    },

    /**
     * Unsync all parent entries for an entry
     * Synced status will actually be set to HAS_UNSYNCED_CHILD_ENTRIES
     */
    unsyncParentEntries (projectRef, parentEntryUuid) {

        return new Promise((resolve) => {

            function _unsync (entryUuid) {

                databaseUpdateService.unsyncParentEntry(projectRef, entryUuid).then(function () {
                    select(entryUuid);
                });
            }

            function select (entryUuid) {

                databaseSelectService.selectParentEntry(entryUuid).then(function (res) {

                    if (res.rows.length > 0) {
                        _unsync(res.rows.item(0).parent_entry_uuid);
                    } else {
                        resolve(res);
                    }
                });
            }

            _unsync(parentEntryUuid);
        });
    },

    removeTempBranches () {

        const self = this;
        const rootStore = useRootStore();

        return new Promise((resolve) => {

            //on PWA, just remove branches from store
            if (rootStore.isPWA) {
                rootStore.queueTempBranchEntriesPWA = {};
                resolve();
            }
            else {
                // Select all temp branch entries uuids
                databaseSelectService.selectTempBranches(self.entry.entryUuid).then(function (res) {

                    // Remove unique_answers, if any, for each temp branch
                    if (res.rows.length > 0) {
                        databaseDeleteService.removeUniqueAnswers(res).then(function () {
                            // Then delete all temp branch entries
                            databaseDeleteService.deleteTempBranchEntries().then(function () {
                                // Finished, resolve
                                resolve();
                            });
                        });
                    } else {
                        // No temp branches, resolve
                        resolve();
                    }
                });
            }
        });
    }
};
