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

const ENCRYPTION_KEY = '58Dypu5HvdjTBbz3RRlWBK2PNCZF0OW612DRQKqMSXTJOcuc0uU9MltrVNDlJae8B18nZgzTPnUWq3S5';

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

    async function fetchProfileData(el) {


        // let profileDoc;
        // try {
        //     rsp = await GM.xmlHttpRequest({ method: 'GET', url: el.href });
        //     console.log('prof_doc_rsp',rsp);
        // } catch (err) {
        //     console.error(`fetchProfileData err for url ${el.href}`);
        //     return Promise.reject(err);
        // }

        // const expectedName = el.querySelector('.styles-module-scss-module__L6PQWG__firstRow h3').textContent;

        // console.log(`expected Name: ${expectedName}; found? `, rsp.responseText.includes(expectedName));

        // profileDoc = new DOMParser().parseFromString(rsp.responseText, 'text/html');
        // console.log('prof_doc',profileDoc);

        // const pname = profileDoc.querySelector('h1')?.textContent;
        // console.log('pname', pname);

        // const pd = profileDoc.querySelector('i[name="pin_drop"]');
        // if(pd){
        //     console.log('pd_parent',pd.parentElement);
        //     console.log('pd_parent_p',pd.parentElement.querySelector('p'));
        //     console.log('pd_parent_p_text',pd.parentElement.querySelector('p').textContent);
        // }
    }


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

                    fetchProfileData(el);
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

    /*
        gets useful details from profile, returns simple object
    */
    async function getProfileDetails(userId) {
        const deets = {};
        const profData = await getProfileDataHelper(userId, "v1/users#getByUser");
        const profAnswers = await getProfileDataHelper(userId, "v1/users#getOnboardingAnswers");

        deets.answerText = profAnswers?.map(a => a.text).join('\n');

        for (const thing of profData.bioDetails) {
            if (thing.type === "geolocationname") deets.location = thing.value;
        }

        const lp = profData.learningPreferences;
        // all false seems to mean not specified
        if (lp?.channel_messages || lp?.channel_calls || lp?.channel_meeting){
            deets.wantsCalls = lp?.channel_calls;
        } 

        for (const thing of profData.languagesPracticing) {
            if (thing.name === 'English') deets.englishLevel = thing.level;
        }

        return deets;
    }

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

if (window.scriptInitialized) return; // in case of multiple script injections
window.scriptInitialized = true;

async function handlePathChange(path) {
    console.log(`path is ${path}`);

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