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

    let faceapiModelsLoading = false;
    const profileListingsObserver = new MutationObserver(filterProfiles);
    async function visit() {
        if (!firstNameMaleProbs) console.error('First-name male-probabilities not loaded!');

        if (!faceapiModelsLoading) {
            faceapiModelsLoading = true;
            await faceapi.nets.ssdMobilenetv1.loadFromUri(FACEAPI_MODELS_URL); // Face detection
            await faceapi.nets.ageGenderNet.loadFromUri(FACEAPI_MODELS_URL);   // Gender detection
            console.log('face-api models loaded!');

            // const actions = ["v1/users#getByUser", "v1/users#getOnboardingAnswers", "v1/users#get"];

            console.log('creating test request...');
            const usId = atob(decodeURIComponent("MzY2MzY4Mzg%3D"));
            const payload = JSON.stringify({"action":"v1/users#getByUser","arguments":{"userId":usId}});
            const encryptedPayload = CryptoJS.AES.encrypt(payload, ENCRYPTION_KEY).toString();

            console.log('sending test request....');
            const rsp = await GM.xmlHttpRequest({
                method: 'POST',
                url: 'https://app.tandem.net/api/funtik/v1/users',
                headers: { 'Content-Type': 'application/json' },
                data: JSON.stringify({ payload: encryptedPayload }),
            });

            console.log('logging test response....');
            console.log(rsp.responseText);

            console.log('decrypting test response....');
            console.log(CryptoJS.AES.decrypt(JSON.parse(rsp.responseText), ENCRYPTION_KEY).toString(CryptoJS.enc.Utf8));

            console.log('logged request response');


            // console.log('decrypting...');
            const encrypteds = {
                users1: `U2FsdGVkX18YtxwF/w0apgPUAmGpDumAeAR4Y/WqQvzdO66ILtuLjEdAlmqvKyIBJIzBGOQ2P5yo/TJieBZLI5ushdZH6yVHvu9le8IRMiHrlKKMcLVDvqQcZ6RaqOlV+hgeI7qSgVCsKd3QgI4wfzgQ9kfWZhao+O1xwF0YhpsrrMsw+UGPydPhY6f4kk5FhX+JwVYhfbW3JPlT2OmjZdK03SPTXVLkRoWrlL8v8O+wh+TN55an/Fx2tlWFCCaGDJO6C4DvEZNj/m8Z/lhakyFtRJU2WyxyPgxE3T1wcCOufbqTz6rmQq7Lvf7X47o5I3JCNUzgOb9eSk9y5oVpoeV74Ff9pJcwrXg9YTrMuuAeD3gRN1QDNq5rN+bD8oEE59B2o6FYk9y3CHuv2VMsq02ep6RnRO01vGs8R96Q8GdC/rFNc3anEG3p9W2ftw72HaIMlQu8soHYI0HxgSyVV8yUqQqCq0DJRaCTJihaE3ZLSX76LsVkeHfdrFCCOTBI1v5+vaKxITuHKvh5nSmqlOc1I3AtEtDfQaVZQrV+KLAueMSIYFvwhoV7stM59uj4GJY0sQp1QsOa9DZJfVD9kEoH2OyiMZbahg4AMgkJmCLarkiQoaIkfVNp1j6A85hN7ETB0B0aufzaAiNyYlairTmWJUESP4qYx+FcL7J/SmWhgxI0ZUWgmJ2jAzgQaeaXHNZpJC1ruu7TmT7uALOMmbKMvdMhqe2ce47Z+zdlzQHHuXCK3bQqsD7R1h9rXagkmpLEHPbHhvqe/T6deezd6L8mPANzLhyjuDElDV5jc8mR5WWTb/6WLPAH+fxHuO3RZGVk7USfFEchuvQ51D95BkHuScSxI1aSFYYh3V3XF+yinyVbWHiowjXqciq6vpPJqmZwa/1eYO1CDxgcQg30KUGLkFXdKB4vbXg92ObZvgM3l9u4PPrsdZjg7aDLJmF9182f16jC3bqzlD4hBPYuqOKB7YNM3yamLvR/ZP7Zs9J4ppcC6PqiT4F8WPn9ASmPNCORmt9zgIcu22KqWEPr/fW1ngze/nIB6wsmLqtTXWUSFJ6ZcuhJe1CvfmkYtsADzKJwqBcBiIjPRSnOqDYwrakMDcHO4AVpSDxJlbGxyNSG/rhOfPtURRzl4HeyXIkT2sK06Bid6mvWpJ+b1O/bGNm+6YseNaB+4SLZaqTxmEkoDH7Gsea3edFGdU025lbRvmeGfZjINw73XDYTH2kLqKxqZMhGboefHS6kgBru74ahZbfK5cpQylov2v2yQVDeOsg2zptIuHnye98mBt4J0NCJ/x61eir7yngjnLEoaUEaS0MGmZc6b7K+f7xRRwAsLhtH/SukO0k3KE2/kiBkbTcdPqx8BOdiX0nR8wgqGWO2becZ+xvIe4dm6Udn6LorAxbrqML0YbaMxx0PqDV+r4AUFeDBqFxOLbKZihq9fmG4rdaJK5jIpCQKVN8MPaFTc5L7Uo0Txl07Ia4wkuaFtlyPT7kosdyYattYaYL0f/cq6R5MT4cU/uaWOGU4wobD2iiHRxSucaZuw/JOhoDklkClJ5Hgaho+9DALunU4zoL+uUCNsx4dVEHQAunmplvAk6KzxuEqhG++HGzYMyFFHic3/fM5NKQYEN0iCAdJiFj5QsOdaCtxRHHy/KbahmB/OpI2MMIZAYed4kUkuWX32vvWh0fBAue8Y3W6zxxJnwVivVs6kK1wnY2YF1t1x5J06i7RI3+cd+UwpjL9hQLHZUfCvfOskVbGydG3pCYIWO9xEnXRnBHYPC7sQvAa01oLMstTM/NZ0jnxXAz13YUqbeu/a5S2WgeCBE2/MxCpwb2HFbHpPXYX+oDyzzy/jZKJl4sd9vQMXxz4Mru1mIv6mLMFCkV8/uSVo1Atw+djWiQxmfaOB1LGL1uTPSoZBaWfjD4fZ/H7XYvUA8yfMMJGAsuydiVmUYoz8oWtZRhC99dO3IkVgwmRFf4WDoAe1yVmfQ5sb6rMGedKup2Go5UOAa/pzciL7ltLsXOYLP2aZqSiajP4Lx4O9lCLtjlWRFoV9nEbnPnBMrPtonHYDosBxMaO7PkLo8T8s3uih/U7B9iyT2LqZGs6diI6JExNh+m7wQgG0KGMWCsH7f1W4ovL+5WV8Ahh1DP3J1o/XQRLhkLW8dGYlOgDqTzBTY76MW8fDD7Xa89UqWVnAozKcZFgo1cp0td3SbGKUF1BhE1CQdty0iEzlrAIUICIqwiR2w/O54ipaCz6835LRItYEF1Z6uoiWTtxU7cHgkcdnO8uPZDH4yU7GLrnkNcj8A1bXFjHUJzZElWarploWg7wlU5gMH+5zleHAw8mWuP7LsYsIfXNxhZaUtPqex8ptxS3Y+C1FX7NGPqUeg9nXU2o9UAZtpRRk5alF92H+z5JqpPovYfDymWTfN1BymgPr8ecYUn00zkQCfviblVIwevSh3Exre45bBztKvzGMJmIa4SQtTuL3Wvo/WpXJdq+8fc5/pf3+gTloM9x13eTqKF/R8zPVeKzrUou0TMWSsDfNarCY9wtfKyNT6f7NNmGLoMIOWpCwUlvkOwRMOa5DJ2H0C6em1ZYl2GD38OeqZntt0JcBRErwhL2gDzAHrUIP3RLo8BFdp2URp0JV6ngRrBVHbxSv+Kz2ekRjDRiywzzRMR/ZmqIEAiYBQ8lsI3V3UdvOVoNXSSwe414km3s/W4b4xGRIIl8u1sbSXxzYXqslpzUAPzzuigrOCTriG+XwQX6mf8ssvld4aQA/nwxZxrPsbC95Q==`,
                users2: `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`,
                users3: "U2FsdGVkX1/9jsYeK9M0WKS4cI1pTHNK8o6xdfrkVvSa4MA0NrnNrlbRJuA+ynFgo8Vs44ZnybsttBsgnlA3BOtFDHiEkbglG+N7wNGOPhEww2efp7+a5xD6oS3v1CJRvw5eXcmSy9iTZf+MKs3O8YVfJALVeDut9kA4W/NU1PB1frKEaWtId5XZW/0s9ceYwFdw7mn+5WClwtzz7UJafsH1hLZ//5VJ4dr9GDFLOxR2bOP/vn9vItH5Xokm4dSlWX3FvQQZTe8LERrHln94wQ==",
                topics: "U2FsdGVkX18vWUaezLdYgBJGy7Nkmj936kSguO/XkEpATnXHBW2NiLGIRVq6U1DOk+EHqxwNfk4gXjQf3WNumGTHWMgYJ6S4pCftimXfJTdXpMZoiLhtBWma/lUENPJOD9I7OPgx3BD2nBrbCww20fCHvJhR1ax/24Zt+NhYVZw1lbOTeuRdSKq+SUbAT/vn",
                references: "U2FsdGVkX1/TMqRmfnghkFsM/xhy6JG43uPrfP4YIo4wrIfscQDIUuzh5gXJPbJK85gdu077gf9kOtC74o00D80ji7fsTcfOp1vCb2IxAiZh0wLkYDXocKkH/MUuBZiCNvkq4FdxFTGTndyKBVEXqL0q17aR6O07uA1NLaRL8Izj3tAnId5vQemdWpFg+0xz/t5A+E6q/YzjJREYcV+/71qo2sW+cq2xzBsFSGu7jZ04MDFCMz+qLMjrFJ0/P8Ek8l/ltn89p9WOpjrnB0OFvfl0CbyYZYZ03rQiJfo8urzKn/XGWIhCMiN1NZVKXu4CB5UE7ye0h8its8K/TGiSheKRYpjVwGQpLxdMknfVoi8IGa+4CSpaPFq1O3hptkQ6f4a29jpS7aBd0ZcYZB3YMHc3X2sZHGNB80zN3N0jEoLXvIw12fqWntvDZ6RCBHMZxoTJfyfUzr0nIb4aRAX3gndahNU9dmHB6BXtUA6mwI8Nt2NVAzWS5HcCmYGfb6jQnFF39fO/aTY0FgfJWaKEAp1/y7hlSUp8pMFA/iMXfNmBy9sWIPaqP3j84nRew4IoO90C0eNLdl2Vx+RL8yInYi8bIOJHhc0vE7K0D9SdlmVDPF+fPO6G1lfl8q8+d2GYAnxkvCurOoD8VFnZxfH9CXRM6bzJzAMQ1wvBMAMGxidCm/LBY7d6oBCS5Q6RvCsnmJ1NfJ/DzMAUUlRo0OtWo4nYCvDAbJMAtBQASKXAHNuwTd0hSMY/RBnURuN2pPG2Z41oD1B9EQBC8FQJWB2ZeJPQ5/mGMqwoCxjNckuDWt3xfr0VmD3LyC5wieMA19vl3EjgMWgelHMhA3D0hyeqqqrfl3WQKQ/m8JrYx781ykT6HjjJOiQ6GF7S0OS33WvahWlhhwT4g7oxHGxVHE8ylvuFgpnYj/muxH9eUj8kw7oeYaibBIS3AOURsI7p35SnAV0qximnV7n2Nqx2rcHOC03aJLoAiGsKVJ1H/e79ARK0vYRwmAVZVFG4jR2dgmKWfOuqDBV5Yk+YmMF1Gt8WW6oihsKV71ZryXBBjmhWu4CyJGwCplPrRix1aXVWGJc0CVfA+7Qla3QExsnsjd3ZL1qXQhZ0joREekcbSoAUBSHXPaVWUfw3uJ0R+m+pDR64DYseL0OzdsNjyqh0BJba22lJkEFvdpZ2Hqx1hHIHKmjYQOznHj0DkJ5IUFo/cfATiAiIVx+ZJAZPP7kZJ7cVPBS+ygjiCmnV4VlXv/2kyyr5wWe8QJeshdhUBMkI4eSh3X51FaiO1RL72MLN80/hyVl2TNsxTvQoUbUsTfAPY3YsxVaRN2+tkiMeNOOlfybM8HIKMGSZU6KcIXpYjQfFrDoC0KppM3f9d9AIEHLb15Xz20VA6zUd8zyjMb2hQA2nCCm8c4g/4a/WQ+nlqwjjR9Ju5GtQbZjD5BLlQB7EMB7Vh7xBm6g38Ml/jcCPCF3g6AbdkiC7yXlgDyAv7i/QWRGeUsye4pK0Mb4YjwCDRNayRS2SHvaJEKZ1vsPju5aNNXvTBzTOQ/ieAAotTFvjVdJH6GDB+yRFIhS/ZVAyL2/HPEIx3ZCNkaD7lhej0CCuUsSf0TRW+B+wKbp44RRUBj8IoukqhBNefsI1LQA+n1QDdmOw+jnTrR2RLdU9JSHgO/FG3ubNHdE9OFTQB+NcHLHF9nFbxOyA8k9QD8T3NgQ9nzrBi3O2GCM65VJy63u1",
                payload1: "U2FsdGVkX18zjSohDs1wTQkCXU+uJ5AB+AaZZx8bT8UR+s/6ErQECkhhcNTV5JRcroQ0mQDdo8Irs9ahfnKyA1oDNdXTOf4o8G+P+seo2YE=",
                payload2: "U2FsdGVkX19UID4sHDELaaD4EWwLs/bxKKGzCvltMtoH5G2xzRejNtsbuihbF6777h/zbzEtpLNTvl9aVbkgVlHx5tNtVac90my/NeePJ/JQYVUQGvGNp0r+NGR/3ZAA",
                payload1b: "U2FsdGVkX1+1riUyp4R34bzm0st2SXDPivivHLm54nQwTau/LG1aBCzLKYfzWDo0zMoi+jvUoP7rrivEg5ec9huvTz0RFykZaEb75ryVSZQ=",
                payload2b: "U2FsdGVkX1/YAaoSu7NpdSjz2SoMhkHB6zEgVCHYzbKGreMUqzjcGgHeYv7PjCMIH/6dGR6OLaUvS30fLTsxXmKMNY3KHvVgzp7wcgp7Gx1k5tPUuOlJR2nG1bQPx337",
                payload1c: "U2FsdGVkX1+Ox2krPZDDbhDAV1B4/F0DMO9QvXnv+qVzNjYMstFtMZH9XaUe5wGoxQuh+WsADkp0V6FKvMJBJARsf2tUvn5z1QTc6w7jTzY+Hb5EbH60Pv9oqiTs2xUx",
                payload2c: "U2FsdGVkX18+CzS82XZc5yQAjWWdHa3ay/8jIilnjtz+kJNolBupVTosMxKLSDSK3AExtoSkjnLt/TaCxcQ8MJkTgHEqJAjEytqDQNXQpqQ=",
                payload3c: "U2FsdGVkX185xoIGKfL+o1Yaja5hB5y92gj2Z3d829IIrdwO4G+FmZVl3EAJ0Fbm",
            }
            // const encrypted = "U2FsdGVkX1+tlVuBsB8c4bQG18uDpg/ZgY1+DZA80tXFUyBNtu0Em+h5knPa0k307QTRfmMK//WD1S59uttk0kARuKjHoybDUOxua0tXyN6cWI9gC+3RAAbzk9LfTHf1m+Z+TfrLhYcBtGeokLvq8ka8XG1BiBijQRCmjt/97JlySIekJuUt4q+McH4cZ79P";
            // for (const endp in encrypteds) {
            //     console.log(endp);
            //     console.log(CryptoJS.AES.decrypt(encrypteds[endp], ENCRYPTION_KEY).toString(CryptoJS.enc.Utf8));
            // }

            // console.log('decrypted all');
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