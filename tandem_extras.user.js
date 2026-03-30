// ==UserScript==
// @name        Tandem Enhancement Suite
// @description filter profiles by 1) gender (name/photo) 2) manual hidelist 3) already-chatted; various kbd shortcuts
// @license     MIT
// @match       *://app.tandem.net/*
// @require     https://cdn.jsdelivr.net/npm/face-api.js/dist/face-api.min.js
// @require     https://rawcdn.githack.com/mednat/tandem-extras/refs/heads/main/fb-leak_forename_male-probs.js
// @require     https://cdnjs.cloudflare.com/ajax/libs/crypto-js/4.2.0/crypto-js.min.js
// @grant       GM.setValue
// @grant       GM.getValue
// @grant       GM.xmlHttpRequest
// @grant       GM.notification
// @top-level-await
// ==/UserScript==

'use strict';

const firstNameMaleProbs = window.firstNameMaleProbs;
const FACEAPI_MODELS_URL = 'https://rawcdn.githack.com/justadudewhohacks/face-api.js/refs/heads/master/weights';

const CHATTED_CACHE = 'chattedCache';
const HIDELIST = 'profileBlocklist'; //TODO: update GM storage varname
const PHOTO_GENDER_CACHE_KEY = 'photoGenderCache';

unsafeWindow.getFirstNameMaleProb = (firstName) => firstNameMaleProbs[firstName];

const LAST_BACKUP_CHATCACHE_SIZE = 'lastBackupChattedCacheSize';
const BACKUP_CHATCACHE_SIZE_INTERVAL = 200;
function showBackupReminder(delta) {
    if (document.getElementById('backup-reminder')) return;
  
    const banner = document.createElement('div');
    banner.id = 'backup-reminder';
    banner.innerHTML = `
        <div style="position:fixed;bottom:0;left:0;right:0;background:#f39c12;color:#fff;padding:8px;text-align:center;z-index:9999;font:14px sans-serif">
            📁 Time to backup userscript data, chattedCache grown by ${delta}! 
            <button onclick="this.parentElement.parentElement.remove()" style="margin-left:10px;background:#e67e22;border:none;color:#fff;padding:2px 8px;cursor:pointer">Dismiss</button>
        </div>`;
    document.body.appendChild(banner);

    banner.querySelector('button').onclick = async () => banner.remove();
}

// TODO: rename function, as hidelist isn't a "cache"
unsafeWindow.checkBadCacheVals = async () => {
    [HIDELIST, CHATTED_CACHE].forEach(async (gmKey) => {
        if ((await GM.getValue(gmKey, [])).some(x => !x)) console.error(`falsy in ${gmKey}`);
    });
    if (Object.entries(await GM.getValue(PHOTO_GENDER_CACHE_KEY, {})).some(([k,v]) => !k || (!v && v!=0))) console.error(`falsy in ${PHOTO_GENDER_CACHE_KEY}`);
};

const handleDoubleKeypress = (() => {
    const keyPresses = new Map();
    return (key, action) => (Date.now() - keyPresses.get(key) < 250) ? action() : keyPresses.set(key, Date.now());
})();

async function waitForElement(selector, documentScope = document.body, timeout = 5000) {
    return new Promise((resolve, reject) => {
        const observer = new MutationObserver(() => {
            const element = documentScope.querySelector(selector);
            if (element) { observer.disconnect(); resolve(element); }
        });
        observer.observe(documentScope, { childList: true, subtree: true });
        setTimeout(() => (observer.disconnect(), reject(`timeout waiting for element ${selector}`)), timeout);
    });
}

async function loadImage(url) {
    const img = new Image();
    let rsp;
    try {
        rsp = (await GM.xmlHttpRequest({
            method: 'GET',
            url,
            responseType: 'blob'
        })).response;
    } catch (err) {
        console.error(`loadImage err for url ${url}`);
        return Promise.reject(err);
    }

    return new Promise(async (resolve, reject) => Object.assign(img, {
        src: URL.createObjectURL(rsp),
        crossOrigin: 'anonymous',
        onload: () => { URL.revokeObjectURL(img.src); resolve(img); },
        onerror: reject
    }));
}

const chatsHandler = (() => {
    function getActiveChatId() { //TODO: move to top level, not specific to chatsHandler (e.g. see toggleHidelistInclusion)
        const id = location.pathname.split('/').pop();
        if (!id) return console.error('no profile id found in chat path');
        if (id === 'chats') return console.error('no active chat selected');

        return id;
    }

    function navigateChats(direction) {
        const chats = [...document.querySelectorAll('.styles_conversationLink__w7AZy')];
        chats[(direction + chats.findIndex(c => c.classList.contains('styles_active__zmQpO')))]?.click();
    }

    async function blockUserFromChat() {
        console.log('Blocking user from chat page...');
        if (!document.querySelector('.styles_active__zmQpO')) return; // no chat is selected
        try {
            const moreOptionsButton = document.querySelector('button[data-popover="moreOptionsPopover"]');
            moreOptionsButton.click();
            (await waitForElement('i[name="block"]', moreOptionsButton)).click();
            (await waitForElement('button.styles_button__td6Xf.styles_warning__QmUuQ')).click();

            const hidelist = new Set(await GM.getValue(HIDELIST, []));
            await GM.setValue(HIDELIST, [...hidelist.add(getActiveChatId())]);

        } catch (error) { console.error('Error during UI-based blocking:', error); }
    }

    async function deleteChat(chat) {
        const deleteButton = chat.querySelector('button.styles-module-scss-module__Uh2fna__DeleteButton');
        deleteButton.click();
        console.debug('clicked deletebutton');
        (await waitForElement('i[name="delete"]', deleteButton)).click();
        console.debug('found popover');
        (await waitForElement('button.styles-module-scss-module__D-2Qra__warning')).click();
        console.debug('clicked confirm delete');
        
    }

    unsafeWindow.deleteChatsWithString = async (s) => {
        for (const chat of document.querySelectorAll('.styles-module-scss-module__Uh2fna__Conversation')) {
            if (chat.querySelector('.styles-module-scss-module__XX3yqG__conversationPreview p')?.textContent.includes(s)) await deleteChat(chat);
        }
    };
    function deleteActiveChat() {
        const chatToDelete = document.getElementById('conversation_'+getActiveChatId())
        chatIdToSelect = chatToDelete.nextElementSibling?.id || chatToDelete.previousElementSibling?.id;
        deleteChat(chatToDelete);
    }

    function onChatKeydown(e) {
        if (e.target.tagName === 'TEXTAREA') return;
        ({
            'j': () => navigateChats(1), //down
            'k': () => navigateChats(-1), //up
            'D': () => handleDoubleKeypress('D', deleteActiveChat),
            'B': () => handleDoubleKeypress('B', blockUserFromChat),
        }[e.key]?.());
    }

    let chatIdToSelect;
    let chattedCache;
    async function visit(id) {
        if (chatIdToSelect) {
            const chatToSelect = document.getElementById(chatIdToSelect)?.querySelector('a');
            chatIdToSelect = null;
            return chatToSelect?.click();
        }

        document.addEventListener('keydown', onChatKeydown);
        HTMLElement.prototype.focus = () => {}; // Disable auto-focus chat input to allow for kbd-navigate chatlist

        chattedCache = chattedCache || new Set(await GM.getValue(CHATTED_CACHE, [])); // don't keep reloading when navigating chatlist
        if (!chattedCache.has(id)) {
            console.debug(`saving ${id} to chattedCache...`);
            chattedCache = new Set(await GM.getValue(CHATTED_CACHE, [])); // handle multiple tabs
            GM.setValue(CHATTED_CACHE, [...chattedCache.add(id)]);
        }
    }

    function cleanup() { document.removeEventListener('keydown', onChatKeydown); }

    return { visit, cleanup };
})();

const profileHandler = (() => {
    function navigateSlideshow(direction) {
        // const slidesDiv = document.querySelector('.styles_slides___NkWa');
        const slidesDiv = document.querySelector('.styles-module-scss-module__nBS-dW__slides');
        if (!slidesDiv) return document.querySelector('img.styles-module-scss-module__UpCcUG__profilePicture')?.click(); // open slideshow
        (slidesDiv.querySelector(`i[name="arrow_${direction}"]`))?.click();
    }

    function createAlertBanner(textContent, backgroundColor) {
        const notification = document.createElement('div');
        Object.assign(notification.style, {
            position: 'fixed',
            top: '65px',
            width: '100%',
            textAlign: 'center',
            padding: '10px',
            color: '#fff',
        });
        notification.className = 'custom-notification';

        notification.textContent = textContent;
        notification.style.backgroundColor =  backgroundColor;

        document.body.appendChild(notification);
    }

    async function toggleHidelistInclusion(fromBlock) {
        const hidelist = new Set(await GM.getValue(HIDELIST, []));

        const id = location.pathname.split('/').pop();
        console.debug('profile ID to toggle hiding is: ', id);

        const deleted = hidelist.delete(id);
        await GM.setValue(HIDELIST, [...(deleted ? hidelist : hidelist.add(id))]);
        if (!fromBlock) createAlertBanner(`Profile ${id} ${deleted ? 'removed from' : 'added to'} hidelist.`, deleted ? 'rgb(55, 255, 142)' : 'rgb(255, 55, 112)');
    }

    async function toggleBlockUserFromProfile() {
        console.log('toggling Tandem-block user from profile page...');
        try {
            toggleHidelistInclusion(true); 
            // TODO: ensure block-hide alignment (currently undesired behavior if manually added to hidelist and then Tandem-blocked)

            const moreOptionsButton = document.querySelector('[data-popover="moreOptionsPopover"]');
            moreOptionsButton.click();

            const blockButton = (await waitForElement('.styles_moreOptionsPopover__SYQ_j', moreOptionsButton)).children[1];
            const isBlocked = blockButton.textContent.includes('Unblock');
            blockButton.click();

            if(isBlocked) return createAlertBanner(`unblocked on Tandem!`, 'rgb(55, 255, 55)'); 

            (await waitForElement('.styles_button__td6Xf.styles_warning__QmUuQ')).click();
            createAlertBanner(`blocked on Tandem!`, 'rgb(255, 55, 55)');
        } catch (error) { console.error('Error during UI-based blocking:', error); }
    }

    function onProfileKeydown(e) {
        ({
            'ArrowLeft': () => navigateSlideshow('back'),
            'ArrowUp': () => navigateSlideshow('back'),
            'ArrowRight': () => navigateSlideshow('forward'),
            'ArrowDown': () => navigateSlideshow('forward'),
            ' ': () => navigateSlideshow('forward'),
            // 'Escape': () => document.querySelector('.styles_outsideContent__B7e2g')?.click(), // exit slideshow
            'Escape': () => document.querySelector('.styles-module-scss-module__lpg_Kq__outsideContent')?.click(), // exit slideshow
            'b': () => handleDoubleKeypress('b', toggleHidelistInclusion),
            'B': () => handleDoubleKeypress('B', toggleBlockUserFromProfile),
        }[e.key]?.());
    }

    async function visit() {
        document.addEventListener('keydown', onProfileKeydown);
    }

    function cleanup() {
        document.removeEventListener('keydown', onProfileKeydown);
        document.querySelectorAll('.custom-notification')?.forEach(el => el.remove());
    }

    return { visit, cleanup };
})();

const listingsHandler = (() => {
    function getStyleForGender(nameMP, faceMP, mpThreshold) {
        const myPink = 'rgba(255, 119, 149, .99)';
        const myPurple = 'rgba(250, 128, 250, .99)';
        const myIndigo = 'rgba(167, 120, 255, .99)';
        const myAqua = 'rgba(120, 255, 203, 0.99)';
        const myLime = 'rgba(203, 255, 120, 0.99)';

        /* TODO: combine scores better -- current hiding logic:
            - if only one MP, if significiantly high, hide TODO: make dynamic
            - if both near enough to threshold, hide
            - if one passes threshold and other ambig enough, hide
            - if name significantly high and face not significantly low, hide

            - average for color indicator if the two MPs aren't too far apart
            

            [] independently controle faceMP and nameMP?
        */

        if (!faceMP && !nameMP) return {};
        if (!faceMP) return (nameMP > 0.90) ? { display: 'none' } : { backgroundColor: `${myPink.split('.')[0]}${1-(nameMP || 0.01)})` };
        if (!nameMP) return (faceMP > 0.90) ? { display: 'none' } : { backgroundColor: `${myIndigo.split('.')[0]}${1-(faceMP || 0.01)})` };

        if (nameMP > mpThreshold*0.9 && faceMP > mpThreshold*0.9) return { display: 'none' };

        if (Math.min(nameMP,faceMP) > 0.4 && Math.max(nameMP, faceMP) > mpThreshold) return { display: 'none' };

        if (nameMP > 0.95 && faceMP > 0.1) return { display: 'none' };
        if (nameMP > 0.98 && faceMP > 0.05) return { display: 'none' };

        if (Math.abs(faceMP - nameMP) < 0.3) {
            const aveMP = (faceMP + nameMP) / 2;
            return { backgroundColor: `${myPurple.split('.')[0]}${1-(aveMP || 0.01)})` };
        } else if (nameMP < faceMP) {
            return { backgroundColor: `${myLime.split('.')[0]}${1-(nameMP || 0.01)})` };
        } else {
            return { backgroundColor: `${myAqua.split('.')[0]}${1-(faceMP || 0.01)})` };
        }
    }

    function getGenderByName(rawName) {
        const name = rawName.toLowerCase();
        const plainName = name.normalize("NFD").replace(/[\u0300-\u036f]/g, ""); //no unicode combining chars e.g. diacritics

        if (name in firstNameMaleProbs) return firstNameMaleProbs[name];
        if (plainName in firstNameMaleProbs) {
            console.debug(`found unplain name ${rawName} as ${plainName} in gender lookup`);
            return firstNameMaleProbs[plainName];
        }

        const nameToks = name.split(/[-\s]/);
        const probs = nameToks.map(tok => firstNameMaleProbs[tok]).filter(Boolean);
        if (probs.length) {
            console.debug(`found multi-name ${rawName} in gender lookup with toks ${nameToks}, probs=${JSON.stringify(probs)}`);
            return probs.reduce((sum,p) => sum + p, 0) / probs.length;
        }
    }

    async function getGenderByPhoto(img) {
        const results = await faceapi.detectSingleFace(img).withAgeAndGender();
        if (results) return results.gender === 'male' ? results.genderProbability : 1 - results.genderProbability;
    }

    async function getGenderByPhotoAndCache(img, id, photoGenderCache) {
        if (id in photoGenderCache) return photoGenderCache[id];
        if (!img) return console.debug(`no img created for ${id}`);

        try {
            const faceGender = await getGenderByPhoto(img);
            if (!faceGender) return console.debug(`no faceapi gender result for ID ${id}`);

            console.debug(`face-api result for id ${id}: ${faceGender} male probability`);
            return photoGenderCache[id] = faceGender;
        } catch (err) { console.error(`error getting face gender for id ${id}`, err); }
    }

    let gTagHidden = { 'm': true, 'f': false };
    unsafeWindow.toggleShowProfilesByGTag = (g) => { // g: 'm' | 'f'
        const gprofs = [...document.querySelectorAll('.styles_thumbnail__cFAy3')].filter(el => el.gTag == g);
        if(!gTagHidden[g]) {
            console.debug(`hiding ${g}-tagged profiles...`);
            gprofs.forEach(el => el.style.display = 'none');
            gTagHidden[g] = true;
        } else {
            console.debug(`unhiding ${g}-tagged profiles...`);
            gprofs.forEach(el => {
                el.style.display = '';
                if (g == 'm') el.style.backgroundColor = 'rgba(174, 144, 82, 0.79)';
            });
            gTagHidden[g] = false;
        }
    }

    let maleProbThreshold = 0.8;
    function addThresholdBox() {
        const thresholdBox = document.createElement("label");
        thresholdBox.textContent = 'maleProb cutoff: ';
        thresholdBox.style.cssText = 'position:fixed; bottom:200px; left:10px; z-index:10000; padding:10px;';

        const input = Object.assign(document.createElement("input"), { type: "number", min: 0, max: 1, step: 0.01, value: maleProbThreshold });
        thresholdBox.appendChild(input);
        document.body.appendChild(thresholdBox);

        input.addEventListener('change', () => {
            input.value = Math.min(1, Math.max(0, parseFloat(input.value) || 0));
            maleProbThreshold = input.value;
            console.log(input.value);
        });
    }

    function addOpenAllVisibleProfilesButton() {
        const btn = document.createElement('button');
        btn.id = 'openAllVisibleProfiles';
        btn.textContent = 'open all';
        btn.style.cssText = 'position:fixed; bottom:60px; left:10px; z-index:10000; padding:10px;';

        btn.addEventListener('click', () => {
            document.querySelectorAll(profilesSelector).forEach(el => window.open(el.href, '_blank'));
        });

        document.body.appendChild(btn);
    } 

    function addBatchHideButton() {
        const btn = document.createElement('button');
        btn.id = 'batchHide';
        btn.textContent = 'batch hide';
        btn.style.cssText = 'position:fixed; bottom:10px; left:10px; z-index:10000; padding:10px;';

        btn.addEventListener('click', async () => {
            const hidelist = new Set(await GM.getValue(HIDELIST, []));

            selectedForBatchHide.forEach(el => {
                hidelist.add(el.id);
                el.style.display = 'none';
                el.gStyled = false;
            });

            await GM.setValue(HIDELIST, [...hidelist]);
            selectedForBatchHide.clear();
        });

        document.body.appendChild(btn);
    }

    const selectedForBatchHide = new Set();
    function addBatchHideSelectListener(el) {
        el.addEventListener('click', (e) => {
            if (e.altKey) {
                if (selectedForBatchHide.has(el)) {
                    selectedForBatchHide.delete(el);
                    el.style.outline = '';
                } else {
                    selectedForBatchHide.add(el);
                    el.style.outline = '2px solid blue';
                }
                
                e.preventDefault();
                e.stopPropagation();
            }
        });
    }

    const profilesSelector = '.styles-module-scss-module__L6PQWG__thumbnail'+
                    ':not(.styles-module-scss-module__L6PQWG__skeleton)' + 
                    ':not([style*="display: none"])';


    const alreadyFilteredCache = new Set();
    let filterProfilesExecution = Promise.resolve();
    async function filterProfiles() { filterProfilesExecution = (async () => {
        await filterProfilesExecution;
        console.log('filterProfiles executing');

        // hide 'highlighted profiles'
        // document.querySelector('.styles_HighlightedProfileBanner___0ts_, .styles_highlightedProfilesBanner__SMBNK')?.style.setProperty('display','none'); 
        document.querySelector('.styles-module-scss-module__ZTDuoa__HighlightedProfileBanner, .styles-module-scss-module__YZDwsa__highlightedProfilesBanner')?.style.setProperty('display','none'); 

        try {
            const hidelist = new Set(await GM.getValue(HIDELIST, []));
            const chattedCache = new Set(await GM.getValue(CHATTED_CACHE, []));
            const photoGenderCache = await GM.getValue(PHOTO_GENDER_CACHE_KEY, {});

            const profiles =[...document.querySelectorAll(profilesSelector)];
            
            console.debug('profiles found: ', profiles);

            await Promise.all(profiles.map(async (el) => {
                    try {
                        const id = el.id;
                        const {src: imgSrc , alt: name} = el.querySelector('div img');
                        if (!id || !imgSrc || !name) return console.error(`bad regular-profile element; id: ${id}, name: ${name}, imgSrc: ${imgSrc}`, el);

                        if (alreadyFilteredCache.has(id) || !alreadyFilteredCache.add(id)) return;

                        try {
                            addBatchHideSelectListener(el);
                        } catch (err) { console.error(`error adding batchhideselectlistener for ${id}`, err); }

                        let img;
                        try {
                            img = await loadImage(imgSrc);
                        } catch (err) { console.error(err); }

                        if (hidelist.has(id) || chattedCache.has(id)) {
                            el.style.display = 'none';
                        } else {
                            const nameMP = getGenderByName(name);
                            const faceMP = await getGenderByPhotoAndCache(img, id, photoGenderCache)
                            Object.assign(el.style, getStyleForGender(nameMP, faceMP, maleProbThreshold));
                            el.gTag = (el.style.display == 'none') ? 'm': 'f'; // TODO: cleanly separate display logic from gender determination logic
                            Object.assign(el.dataset, { nameMP: String(nameMP), faceMP: String(faceMP) });
                        }
                    } catch (err) { console.error(`filterProfiles error for ${el.id}`, err); }
                })
            );
            
            GM.setValue(PHOTO_GENDER_CACHE_KEY, photoGenderCache);
        } catch (err) { console.error('filterProfiles error',err); }
    })();}

    let faceapiModelsLoading = false;
    const profileListingsObserver = new MutationObserver(filterProfiles);
    async function visit() {
        if (!firstNameMaleProbs) console.error('First-name male-probabilities not loaded!');

        if (!faceapiModelsLoading) {
            faceapiModelsLoading = true;
            await faceapi.nets.ssdMobilenetv1.loadFromUri(FACEAPI_MODELS_URL); // Face detection
            await faceapi.nets.ageGenderNet.loadFromUri(FACEAPI_MODELS_URL);   // Gender detection
            console.log('face-api models loaded!');
        }
        if (!faceapi.nets.ssdMobilenetv1.isLoaded || !faceapi.nets.ageGenderNet.isLoaded) return;

        const waitForListings = new MutationObserver(async () => {
            const listingsGrid = document.querySelector('.styles-module-scss-module__YZDwsa__grid');
            if (listingsGrid) {
                console.debug('found listingsGrid')
                waitForListings.disconnect();
                profileListingsObserver.observe(listingsGrid, { childList: true });
                filterProfiles();
                addBatchHideButton();
                addOpenAllVisibleProfilesButton();
            }
        });
        waitForListings.observe(document.body, { childList: true, subtree: true });

        const chattedCacheDelta = (await GM.getValue(CHATTED_CACHE, [])).length - (await GM.getValue(LAST_BACKUP_CHATCACHE_SIZE, 0)) 
        console.debug('chattedCache delta: ', chattedCacheDelta);
        if (chattedCacheDelta > BACKUP_CHATCACHE_SIZE_INTERVAL) showBackupReminder(chattedCacheDelta);
    }

    function cleanup() {
        profileListingsObserver.disconnect();
        filterProfilesExecution = Promise.resolve();
        alreadyFilteredCache.clear();
        selectedForBatchHide.clear();
    }

    return { visit, cleanup };
})();


function encodeUserId(userId) { return encodeURIComponent(btoa(userId)); } // numerical -> string found in profile URLs
function decodeUserId(userId) { return atob(decodeURIComponent(userId)); } // string found in profile URLs -> numerical

const ENCRYPTION_KEY = '58Dypu5HvdjTBbz3RRlWBK2PNCZF0OW612DRQKqMSXTJOcuc0uU9MltrVNDlJae8B18nZgzTPnUWq3S5';
async function getProfileDataHelper(userId, action) {
            const usId = atob(decodeURIComponent(userId));
            const payload = JSON.stringify({"action":action,"arguments":{"userId":usId}});
            const encryptedPayload = CryptoJS.AES.encrypt(payload, ENCRYPTION_KEY).toString();

            const rsp = await GM.xmlHttpRequest({
                method: 'POST',
                url: 'https://app.tandem.net/api/funtik/v1/users',
                headers: { 'Content-Type': 'application/json' },
                data: JSON.stringify({ payload: encryptedPayload }),
            });

            return JSON.parse(CryptoJS.AES.decrypt(JSON.parse(rsp.responseText), ENCRYPTION_KEY).toString(CryptoJS.enc.Utf8)).response;
    }

// async function fetchData(path, action, args) {
//     const payload = JSON.stringify({"action":action,"arguments":args});
//     const encryptedPayload = CryptoJS.AES.encrypt(payload, ENCRYPTION_KEY).toString();

//     const rsp = await GM.xmlHttpRequest({
//         method: 'POST',
//         url: 'https://app.tandem.net/api/funtik'+path,
//         headers: { 'Content-Type': 'application/json' },
//         data: JSON.stringify({ payload: encryptedPayload }),
//     });

//     return decryptResponse(JSON.parse(rsp.responseText));
// }
async function getFollowing() {
    const payload = JSON.stringify({"action":"v2/users#listFollowing","arguments":{"limit":50}});
    const encryptedPayload = CryptoJS.AES.encrypt(payload, ENCRYPTION_KEY).toString();

    const rsp = await GM.xmlHttpRequest({
        method: 'POST',
        url: 'https://app.tandem.net/api/funtik/v2/users',
        headers: { 'Content-Type': 'application/json' },
        data: JSON.stringify({ payload: encryptedPayload }),
    });

    const followings = decryptResponse(JSON.parse(rsp.responseText));
    return followings.map((user) => user.id);
}

if (window.scriptInitialized) return; // in case of multiple script injections
window.scriptInitialized = true;

function decryptResponse(rawResponse) {
    return JSON.parse(CryptoJS.AES.decrypt(rawResponse, ENCRYPTION_KEY).toString(CryptoJS.enc.Utf8)).response;
}

async function handlePathChange(path) {
    console.log(`path is ${path}`);

    const followedIds = await getFollowing();
    console.log('followed ids: ', followedIds);
    console.log('followed ids encoded: ', followedIds.map(encodeUserId));

    const encryptedV2payload = "U2FsdGVkX191vj3zwYGikyFdlmch0EPTruleaT1OKJ3YNEDrvv+RmtjJN2jj7jKI8zhS90bjgAcPDEpYmJ8J4BfhACbkX/sRWLnIDG13DDw=";
    const encryptedV2response = "U2FsdGVkX1+JTIYDlnO88X5hU5ZKGoiovyUyQ+n7a3HukIDooihgSZ+o08+tElcGSSCFJuyTgsOLEydaKKLzJQiKjv5C0+9uIezqQdFpto+qO3oOebA+mqZGv3RASSFc+jOtz2fjH6laUeYUExRi4scqKk1LV/wATyBVOa7MnTRUKdoXNjs5YBP4e4DaZeDLG/NTtNmIXncb3bdhvE/juCUIH7eGo7aVArv71F3Gi8+DNBeGWAhfLzWXhGnx6g9K4XrOSJCokCA5GIbgDFSXQU+ccGY9og4yTZCOKFX7GwG/WVmBfnLx6onENapIe5x+wf1wVp43jDV5biV0Rkk8p9RV9XICjBnVh0r+VrvQC1JfnFQCXhkGdUqKFTumstvouYFkZXVJAXSDV6Ya0Q1lrqHBchDUjt1gmZggVs2y5dD4wcMkXtAhW7SCa0ea/RG3Zs5scHNGwFaVIlQZFyhmaPijYgpxmlQJUzAFYK1h3cWRuvoKBWygUarrVL66M06/+poVlZlNT1eLkMoODcsFMD2NLg3ttcA8ok0iCSmWreWELbAeweIFWPebjQ8QQ+NMi3HB8WOLc1uFKN3xC4MWXqQX06qcgPYE6g+i2fJFRfITHBTHBwECzoDRk9HrDxpQ5aeu1HTIZOv5sXT6rdJSb+d/nBNDH31kRx+hnkvZME6jJciZ5xpe4CE2hUsn84JdCfAlbeeaY1iRgDdSkgebDTIDqpTOHyu8TgfFSRi/PpiFweyddkMqiwgOIXfM9sFjDB+vw+2vYLPmGm0/mFGdlKLgumqWOeTV5uD0NPKvd0sOp+9D1SQpB2QD8T1l98nyvmNEsD4JydOxWmiFtCv+Zs7Gz85GqzYXap4HGgoAoL9MDrWfbTGykg8wYBofvIkUFmHf5lnCLv5ZmCbh3z8d/LKVvX+CL3eZjudbNje8DGuX2GDtrTyPwX5H0dRkPUhEpku/e3mrCEaudkXrxvP26WMl0ybogS9nvYzxZSwUOU5fsup2/qrfz8tq0h1MmrVUHgr5dnQ3TsMXd5CyLoyit2E3CfjqO/AP6eVjWShDSVDHXjv8dSVdjEGKswcu4eySeQYBFm6XDPz1REB2DLXzPzuQDOLpsXlJosxBg3frMwW+CseRTermNU3oysKqdA34xwjc/W2dRVQDmLRYXV5aKVtWtRWcDpd9QVZAAByDIBQlER+j+QY1h00tRcL5aS0BLKGfwNBn6b1gizNf/lX+nsz2fmPDInrGhkbNtS7WOvlAZ6Z2pyqgYpYys9dx+N8hZVtxDq9ItIo+nNiCxKwcAFh6vqYEyOLLVemJffQBWcQGCN+9Kxxor2+FnCx/YAzcjb4mRXMWtAwsufO0DXrhK/wMRFsY1Q8An8R2hW0JusvP5SeiS4LfpLFxKQoSEK+ZUZoTcBMaW0qsocpwgUSTQk4rbqNrT5YKnGD9uPNj01DCYSRYa7x+2LmQxZln2h81HDFizD3szspuDstEvJMbMyg6AdALGhFCZHDkS9Mt3345EuNbC6NZdd0XvBzasW680LIP5po3mysnGzo1s5iMp/ftexX+Q4eOyIA82pM4XDinoXBFj4ofJTxCijpAZeBo8k/k2Wf1livWS1e3+jSq2Don58L7W7r3VX6fQZcX8kU6cPK/7BYU6cipg7bUxtWkadWovd5ahiH48dooEjYkdOJir1mP7eRC3b0WvK4n0nIetgyVD1BGUEEXR1uXavCkvilLXkzQiQaKKntULxCsU3q7RGNpoLIciMcitMWMdNFtWzFY/PyrPJXyHcBLj3dOzh9wXlRjTBATxmYb/MaD46DI94BCB4ZMGWsc+Ssee9x7huYC1/Z6awRw4K3k+TiY9tB+G7WYLZfwzmTIPBwZX12BzSnHmEDiMc+xmBNOmbpprruwL7SkpMENVLKiPnagUoxRmVSCwTyj22KDJTTloUs87g7m+5L3pePaOIgSWDFn9RTMRx9NgA4fXN/NQtB400Zk/4N5WQJ1aMPtw1CFNcAfk+EprmRAKpRQCHd2Vd02fkGTREvRHFtZ76E2yz5SB/QOct3IRipRRLaYd2Xn5Lh3YShmbqdf6ckWSyVdL7aKUFEfKJRiHpRMe71KVUfA+2Fb1+jTu3j3C/wfiPWB7BDosXUJpYFYJYfkGgUwElAvRl/LIB8uLt6WEJw4d3/UHlXhrpZwHny6rch22bgT3mifygrdyhZf6PoQZ+YZHM/Q3BupTzK/2ebUcWaTGSuglDnaE59GrDi3h+NcLX4G51F6Sb2thlSZ/vyA7EFHYNTOuitJK11/oE0iOh+dVU9NDmrEyQ5ymbwzzOWXrUokJWSLzGULOihSMdr+9Nc4BaYPAoLcl2oNmMw6482Ox2ofApSUEo7hgXvRlQsfUe2aY3qyMkZklIyCpr/2pUjb4hvu8/uoikqE2Z1fB1D7g75UZEqKCjA9bWigMurRZcp6MXo/+4shtfUsFgxqz1eUVzhsyXLRSNlHUw5XHVGafkcczUKInSySPDS/jo6hRM/6NQB+XaW79N8ewWPlIq9Wv4oHpGMqUIn9iiU3vj04HLBsOd49ivovBfc/ec0KNBLXJ0TOkQiuhh10RURkBlUM1MIL2FMPFXMSalaTGYKz5kf1MOv+z0gT29tZEBfIB1Uzjb3sLZqqX6GCWVGytiaTKsRPt3HHzVUNdnHkKt3lpeCCfRIemuq2kZroKwuqrx7e5KZFvaD2KNSwL/X2osXOZ72DMvlEfvm3KKQFuElvmdObsKaozGvIPFqmYWaDzWvyPijuvTSjqcHglFh5Wx6QOoLbHE6DX1n6c2k8ASIAjIr9LyRs3O2k3EsrQSS22OKbt5LpNapi6IiQYIkFqpug6Yp4KA0owbQa1l6Wj2tsphqXHXu4pBLwDlthgLUkCvUkwvz432q+2VzXj8GOw+8hfIyVFdJhjDS+jaXHIqJpbJUDHS0Qw2YeAdUFqAf86e4g2aFCy5Hz1KklIx05WnLJ2d1JM2cJU96XlrvYrpE2i90RdSbW73bzImAMN60s16c5GVS5qvbTMVz1c9oPzGKrZPltI65Z+cHoCciPOAqDyAd+eqBihOarlaux0bOCC2R7gt6NC3HZy5Na/w0RtX0E+B9mWKTSN9XCQCfC2s1XMc6Elf1bUWXUEHwlZi/h/R2KTj9pQiP4oiifnAfxdZ7Kt0LO/T0NxJaGWIpRummtkLPzN1PV2MSrm6ILunjQXiCRXBiq4jSPHOCaOKsNZ3Mn/QbQt1HWSVkCTeEwNvkCRdtaarjiGkw2LaJwHLisGdEsHIwJtM03M6i1MvQBdnfzPTiGyZwy8AD78UjLtJrL0Y+iQDjpj9NlZfrJz1DSqM/j7FtsgAeeKUH0TY8bL/qeztmHePm/LlUbU4bsrPWZwAS4taddY6CUhWW1Eod56F+oWRFTCfROB7YRnATKVg/Vg57kb9QmIQlj+GuqNmuSHYpb8NvkkN3GPrWpBmRJjjjMvfP28co2blgZYi5w9D8jvxSaoSvZtplWHYOkWmA+y3+zeu1aZaqWK140+xWUGKRldq8IwfoEosZ9VKiva50pR1ydrsdTF0VjJ24OHmWS0J9gkR2bc14Y1Izdkc/rhvvkpeBhOlcnzkWX/UgYytycyiRJrFhj9DBO0LxvtgPrXBomZj6nRiE5kHsCZxnB4BU8SqPLwVtJqTEgEiUm5DQYJ4k2ZchyVtsrdyhfXT06vANkisBJvDjBtGQrWlHuJAGJgBEkZ57/C1nCZjaHSg0/uTRpgjKMnbaFkZaG2oknd2Qv9Wezv3q9Jg6kzUHdsiSj1cohwDjlkoZXO7Rj0bJb8/wIor/HR+QpIKVavTdOWFTR+w0lkiXMWUK0Fkudprz/f3c2+/1ntvfkH08PZe2dcHwJSqfayOW6B0T4PDj9SKTrsMRk1ssy+EoanhkVFU02GqGP0h7PoskDajlo+USKmmMYBfLMKhPalE9idMq8QzDvEIMiYe+Q9xDIWEhxjPfVN49QgQ9GiFvPrJY5TJgVIasBfPJivjM6aSWUd1ODQ+z86IV3jSoNr0UBcczeLxvp7ipIYNxCQZQBNTbFEhhMuYS96zxr5NlHqOmiqFav8nsfEysNbiK31KjXRE70S3gs2/dQRFkoAHgJxA9N/67wwj5G4/Cc+HTFsGyd8nr7i+vfnVtjQpwNImTQUABedPp4ezbyp/twY0QGzLOz/tipOaoK4iyQyDPDKFXkUI9cefDcQfX5sa+7r6FOAuwi42uuEQxvw/nl7BGABBqOB/Ya2nWKWOUfmrQnFvXROA5J7seSjvxjwtV0g8cOVd86aYSC9O1AJeD23z36xMIlWG7FLV1gssk06o0rUX/BNEHNT2NCjPSjm4Ttj+giTq9OeaxOksnOspKx0IEPFp/vcG0iYxtV8FKdeugznXH2YotxYUIPZ/009s4vIZp9b9kibQW8J5HNuFGCnUCehdXeVGQ0q/HEEaLZPkkpBSWCMaeLgnoZpu8MzpPFwZhCVGLDSFnlrkYTYt1wt1gDf0RAk5br3QSmrvWTb0QnlDIl4RIUXbyn1//HWRW44zuNihfqoIrNRkRdZyUgFXe90XQUz9n/BT0+nA/ztYsd+pHkIph0GKtatTXacdoAkc+fG1ZhudJuW7ggcZPjSeb/MTANAySqt4JVENCCidsKkQ0ymKWNqMndmd62mEUG+PFFbMWE5v0qNFlrQbiA1tD9vD/HrLhMsMjrztvodJLLNr6b84COmgIAP9hwq/cN1dBHNzYlh7q9qdSPbjMtayT1FjnlKid/Gu4YmyF1yk8/owl3iNtlT5ppIAAf6W+pJKrmUykYrLcK0swWDzfk6ETm054UYJXLzY+GkZ0OK8wASMTxuVTRSpIffoNGSlNS4bhw+Cgf2w3hLBUykVB7zVY8ZdnrLKw3pNWvyA8OJuilTPAx8mYDvYdRHgOVauYl4cnHpi3U5q5zUEp0m1OEl7eee/XPcXi9X1czSyA9Ji4/Sr8rUfP8UBYdNZeOS+tBV7qZ3UpiH5BlZYNA2XMc+r5SKnZxQDlrJLmCRo6IBpwriFrJaK1tvQ1j/sppC6VYknT8o39NM3kPQVd38F2kyfbaNBl2ZL//irVnOZ76Orl1izFuFUJ65xbmPdZeX5FXArcoy+RWin99lDjRkaSKBZ5vZmMVkquc/eXRiFWqnI9nIIdqTy5rxuKiTKePocNLYWspmysGe3LMaE/NYenfnoT62/NWLdBUo4Q87Z1Vt0mI8i1NpwIsPPCaNfM3t+0LrEpUOue5OaxUsgDs6tub9I6tJE+PywEBuvSk7EhUuU2sxKKqUcpiVach2NwBXlHKCo3O8lowHiF27nKmMHQcma0I7G1FIDrplkjzHKgZF40u/18NJSOQi5nTomMvbUE2zVDMBOylE7Eo3kode773/VefCdjVkj6hwRCdTm/JFY59VgxzpMglKxHOE2W6PdvWXIzmk1RTrekSYk9LGiPfm25HMjwLscZUD0gSUbCF1jyS4nCr6LLVLbl7BZWfIuk40w6cNRJxHZHuzIi4s3iR9YOR/knbzdFFc77S8iNGV88ATlZQNMzvY0+4rOMtmtMgkHEL9Ig7VyuhMai+nWtQUHL4WO5fSxW635zBwENWDX9Y8A1x43bcNvvHQ8v7qLJr9hpCCsOLuwoQQzirWxhdaMEVUNCjvnNTasQxqJ+obko5AnvpLrTiQMi54gV6dj9QOr5sHVx2XR3SVKnBnidkRFUYKR7vHlGD1GGFmZCv72frNPXHII43Z7L5+d2fevKw7Uw99XwD1alLhH8WKoHT/LcCrzputkXXqKZPjA5eMDrhryRt2W+E3C8dLVy6myLpDvoZ4k9ctM46EpDHs3iDTfACa8Vkn2fPr2rfz0Hji9kqu6bpP4IgHmhTX7DrfATyJtC7GT1c2dDZDnucQM3NaKxhW9LbMp9BdyfHL3g7nJVKKQW86/+u18bxTmloZaQlrpEEWzgsYHeDc3DfCdfwibkry6lDAfrcV0IBt5EbHwxL1EL/l2jlGnrFYi3BCGJGqP2vdUHBU1UGOoG65NA4WJt2BjVyeF1smJvtM2kifd0MAZ+jFCSg9eQHfnwQsuC6oBegX40evRb5kR48/g0cAzrbizQBNAQ2ms7phNyWw5JJKoaNOSCHyIt3tr73rM40w/PBzlZUn3o8RlqKamr8p6NU0vuYzjLetM4bUCbwpDp1IHEDXCvYZcqiZCfXyQvRh4OI7rQgnOjRsyXdCNISFXiZJc95lUaMyOIU59jX1u27ON+UH3Ld9r+jbAKd2ONMnmYmeoB6q00iE7/lrEcNu6d6dVqJ3WvIUCtCcjjVeHsrShx1/FK0dJFryTLEgTMhNSk5j1UfxXyGmJjlVI6MeJQkGSjX71L8iU8EVB5b0TSYwFlxRvsoqO2mvWYkEXZs9Xy54R/JawkUFWl5AjTOhtXiKB6Vxqy0JKcpLjRiRZNvv/ytB5xdZga6DOkJG3WLZuUchibUdpDyx5aV6GIDqzrHVQMDG/iJvx/zqimUfSzb5jaUlFGP7c8xbt4EuIeu89d28nPBT/Vl7XY0fhovyYfQNabPxw3mLqZ4DMnsyGpaUKLBy8Ult1+d2lSSqtbMKAi7mewKaKhwFIpeTvk7/rEJ9+1ugrAbNVS4ZBA5IcIKWwmMjGIn5wLNYD95XvLXA4x2fapFM/4WQGmSW3LC2skISAoaTUoSUo0JCyZh/IVKuFj8sbmW76ElJZAz1Uj4OQ/5dn3ekKzksRa2Ouy53C7u6ghoZ7q7Bg8FFPevjZ10VLqrMCFdUPlyT6OqPfbsJFAWVS6TswErW6UikstVeULian7hWGgcg41PhJfSs2qVd5pzpV2R+0n6CaZYTKfBo57lotSWf1z4yg0wEhj8kQLEaVQQruJ4A04gSaAlCWghONkMoHIhdBM/i81N4+RVXfJMn1pfC0YenrXz0wUJQf23DjomW6GKOim2Iab4FacePcNB0yXkBN1y6kbyL5EpOujwsAjlJNNh24kovY8febpwhScm0fxHPFDqj/kRML+TMhlqnIzD28OrltoC8603VCH0BbrfGJtmr8E5YGyo/jQl7Re7l4gEnTer5+iBG7GsW7fUluP0iTp/jW3QFwpgscRNXCIP+DBKUh/QLdx9lB1KHVvp1oqdQcPJ+Try26jIKEpxegalWm+ANvAr+C13ZNpHoyl1L/d5xF3E2UcRD+kkXk26DGOSw733+BG4nzr0dqe8rSSloR4nG34dBm7DGOv7XLppQgRAsTgjWfmH7I6MCdhtkTi3nZiG77dXOIhKpAX+7tWt5vTPJUhsC4OPnLVJweuzamxJDi2bEJkiPNVj7+iOy0ETszHrGWfYsw6VfHaanHGliVSRa6TLKe2ABZ93Y83UVPShlTSzQ4YXXQRPj1e9WjPb8nK9C2j5pSTknO27ewFQrHJtaENcXEcLr4/WDZIxBFJfyCDxlVUuRkSo0DrhP34WaCxU0+QxMtbR5JZCs0YWgSzeWLCNK1e1qC5jZ4X+Gpi/kMWRlYuYL1yTkbLIqOCSXRANt1j8JN+BUPAFBrgEfatQi61u/FZ5hSYIBhf2qdVkyD96ZtpzeJKW+4BEzRubOvxFm4dJhOYa7AR0xTfQbYbZSHpIqaBUwQY4tEZsweBzEJhZe9cCGbR6y46/AWQkwkud7RpPDSNUsjlnlx1kUUZGy4BbdVqDmbHewlUclfIPOJ91Czc6agOeMiZlDNlo3dC1mAavYpMrE7jnofLY6JxljUHGhG5Ma/mso07+Ht+giqsAhwH+lAouoUkSOG4blxJG1zHtrW9WACcq2ncYHEGfN0TcvJ8FJ6y/MT64RlNORDemdy2T5j4/DyI1dc+f96zqA+ItgzZw9YH9AN2QqEQFtx8OOjEse+Wfo8Sa4mpwoI5wRPlWaOgnAZupgtw+6cyJzp5Yylhjp/GXCpgum7dR7EwfFA0jhHRsj30afglpLKcSVTcuDG8SGW6Si9R8GiZe+VSlCXi7vCkR6ZOlyqYtJTIzaKN6GlIqvNle2swRjvI6l2f7+lX9EwyvEls8MfCVeJHMp1FyqAHdjPmi6glvNSiJPrPdkiu20QHoxa7+yitjwtUba67iz2GHbWDoZwNFONM2j7gGT3vpc5aQXU+eVx63W+NFgUcTT0ZJ5rle00YHvPeZGmlinkURj988N43zezKojIIlmwGe/5l6RsBoVm2YQ399MqkzuJlIzHWSlQ7Fnczy404iYvOHMpzMwLNk4TYozmI0Mu3weZAUqnaEcRdlO4+za4ktQJVmrmzMb5qgccsMTTSad/lYH5I7tqRl25qTt6QNLeY+2sWprvCig4MyxwiNQNcBf0BJ3KrvSsybtg/8LwbBxUxbGdGZlsh1idvDV6WmqNyM5HMCg5D5jiITJXKU9hSlC5TyJxMwvZFHb3ID/0pbp/Al3edKKc/gDxQbLFIa+UDDiO8Vixk4D26ufYMNStA+2f+E6MH9aZLqnszay7+R2VVWQRswUFn3N4ZOPrxVIfF3mjNner04BXvi4KPz9NkeuBqTcZW8PQuzViNO8wivGdFmKSiq2kzO+091yOcXWp64YVzL+uOmJONDVh3FHtRrdZVapdViHbk4ZkHFvrIzgAWGtxwd811nfs1uo1BKE2QY+VWXmkEo+bKBMu/iSyAfKGBY1iPPJ55XyUCFzDRQcCLIayoFrD/Jdc6cc/6GzlfnWWeyQ9wxryISf3n5OoMtj06j/9CgPV5EBYa0MYtKalWvHbIXmL+mMVbgXHggXaaPRJS8ewjI/X3f0gYb4MPKByuIAOUnChlcB44AkkKanRh06UxwK7ws6fx1qggh2bJsqvsN2Okgy9lbZFq4BXqtiovEtctHPtPlvzoQR6DFxg1KCZVyJQCNTl9HYzaTYQ4wZtdvoehQW8+TJc1hnVwC/AaMlCL8Frbz8LHoKkKGI6JnxY91LcGWKvPFg99sa/aFjCIXaPqMOnwhQRlmUYwd9zmzT6lVGMMuBEBD4BRpIu6ouy+UsHDNceq1fEEDUAhdEuHJg6+ecbTe1NH8+KpzZTOc9HQzWO4FNGlvbHhgmb7fHE2UVpPiHCl9vHGjG//pR5EW59179ehiQZjWUhtr5qGg5YrUgzWHh9PEl0ocP9C48FTrjos0H6FPjNmQHCP0ThDhNSKpu9tyvGVZlKX2P4RFG5pEuwJEkgnhdCBg61mUrjg2ifxeDBlyZ6T+QVlyxOxFccN81J3Zh/8bukyH48TyiVDAhWWlj0/l/d7Om0eywTO7kxFXzSvX5lDE+dfma8ISUehlSSaCIs5NlHcKr/pgYe9wgeBpEIRDiIA2wHqerClltigFNJKA941+yf8Zc5vAWD7lXnSgjCj0o3+Y7o4+0610m0m+0iyFjMb6z6BlU6p+SbwaHr18JjHjhsgKX6W3THYv2k37zt6biQ4syZ9nOoZAe24fYoj9GjXcwcKIgWjj0sfE2XMGLCyasaxuSV3FA7LIdbdJ2kLNHRXF/xzp6n6AY7J+t7S0u+s770cpOzifJePY9fFwGiwQ8oHGbYH0fCs/hfhL+bIwjBIrdsKn5p5fsYOUr47zdD66HnFY6j/xTue975qDcExx5lQ5ocyh+nNvXrcFeB8OpS7TQu9cg1PSQTy7Pj/PF6SETXhnA+mqvG1sYPVKdVZvSC2nfrMpuJ5hQ7xhrGTvdF5mJCN9UbB56cPoul8jQn3njEwXMpIrzX0pqetf8YeB22rlwQuftfDygGuVOW5Xa/o8xOlUyVaCuU1u19r7On7viDQZ5m7JrN3P+ROJyqOPUbb3RU1f8C+/d3nIOoaEq+jkN4u4QbGVprcKvnEwh6j6EfcE/YtnxqTVu9RMK+MPR9M9daT1cOsCeX3B29QaxpWUDR+G0BwKD19bo0Dhucbz81VbYU+fhCRo6Y/w47JE33Z57w41T5h/bcByM1zFtGIFELSb/0AjLhMfeTEgaptOsROvukRnYLEWeBpOYMLpr0yS0zlujbWsZW5mkMrGP5ghaaPgb73FmzjJMe7oHP2k/UDYpjVTx9P+HivgFaLBL4vBPLgS7NX7UHt1F1LpAgpLzNagH5NxFKO68gluBbngVBW5zzC1nt3WNJtJHp5No1DPKui4cIND6Om6Hho8s3GhJqMBNNreskMScyAyizqrlvRLT1dqgts=";
    // console.log('decrypted payload for v2 endpoint: ', decryptResponse(encryptedV2payload));
    // console.log('decrypted response for v2 endpoint: ', decryptResponse(encryptedV2response));

    [listingsHandler, profileHandler, chatsHandler].forEach(h => h.cleanup());

    if (path.includes('/chats')) return chatsHandler.visit(path.split('/').pop());
    if (path === '/' || path === '/en' || path === '/community' || path === '/community/near') return listingsHandler.visit();
    if (path.includes('/community')) return profileHandler.visit(path.split('/').pop());
}

if (typeof navigation !== 'undefined') {
    navigation.addEventListener('navigate', (event) => handlePathChange(new URL(event.destination.url).pathname));
    handlePathChange(location.pathname);
} else { // fallback for browsers that don't support Navigation API, e.g. Firefox
    let lastPath;
    setInterval(() => {
      if (location.pathname !== lastPath) handlePathChange(lastPath = location.pathname);
    }, 50);
}