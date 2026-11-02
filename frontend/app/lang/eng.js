/** Archived English UI copy; runtime currently uses Russian only. */
export const meetingUiEn = {
    aboutModel: {
      title: "About the system",
      close: "Close",
      platform: "Meeting platform",
      description: "This meeting service is based on MiroTalk SFU, an open-source video conferencing platform.",
      platformLink: "Learn more about MiroTalk SFU",
      license: "License",
      licenseDescription: "The meeting component and MiroTalk SFU assets retain their AGPL-3.0 license.",
      licenseLink: "Read the AGPL-3.0 license",
      sourceLink: "Bodrik FM source code"
    },
    chatComposer: {
      imageDraft: "Image draft",
      removeAttachment: "Remove attachment",
      attachFile: "Attach file",
      message: "Message",
      captionPlaceholder: "Add a caption…",
      messagePlaceholder: "Type a message…",
      send: "Send",
      submitting: "Submitting…",
      hint: "Enter sends. Shift+Enter adds a line break.",
      status: {
        unknown: "Submission could not be confirmed. Check before sending again.",
        one_file: "Attach one file at a time.",
        invalid_file: "Choose an image up to 5 MB or a file up to 100 MB.",
        caption: "File sent. The caption was not sent; try again.",
        no_participants: "No other participants are available.",
        length: "The message or caption is too long.",
        rate_limit: "Please wait before sending again.",
        policy: "Chat is restricted by the moderator.",
        recipient: "The selected participant is no longer available.",
        rejected: "Message was not submitted. Check the connection, recipient and room restrictions."
      }
    },
    chatFileAttachment: {
      preparing: "Preparing…",
      transferring: "Transferring…",
      completed: "",
      failed: "File transfer failed",
      cancelled: "Transfer cancelled",
      unavailable: "File no longer available",
      download: "Download",
      cancel: "Cancel transfer",
      error: "Could not complete the action"
    },
    chatMessageActions: {
      actions: "Message actions",
      delete: "Delete",
      deleteError: "Could not delete"
    },
    chatPanel: { title: "Chat", publicChat: "Public chat", direct: "Private messages", conversation: "Conversation", close: "Close chat" },
    chatPersistentImage: {
      unavailable: "Image unavailable",
      loading: "Loading image…"
    },
    chatRichContent: {
      load: "Load external image",
      image: "Shared meeting image",
      unavailable: "Image unavailable",
      open: "Open image"
    },
    chatTranscript: {
      avatar: "Avatar of ",
      messages: "Messages",
      unread: "Unread",
      empty: "No messages yet",
      me: " (me)",
      public: "Public chat",
      private: "Private message",
      locale: "en-US"
    },
    chatWorkspace: {
      drop: "Drop a file or image here",
      loading: "Loading…",
      retry: "Retry loading history"
    },
    notifications: {
      joined: "{name} joined the meeting",
      left: "{name} left the meeting",
      presenterGranted: "{from} made you a presenter",
      presenterRevoked: "{from} removed your presenter role",
      mute: "{from} muted your microphone",
      hide: "{from} turned off your camera",
      stop: "{from} stopped your screen share",
      unmute: "{from} asks you to unmute",
      unhide: "{from} asks you to turn on your camera",
      start: "{from} asks you to share your screen",
      lobby: "{name} is waiting in the lobby",
      file: "{name} is sending a file",
      lock: "The room is password protected",
      unlock: "The room password was removed",
      lobbyOn: "The lobby is on",
      lobbyOff: "The lobby is off",
      joinLockOn: "The room is locked",
      joinLockOff: "The room is unlocked"
    },
    participantCard: {
      presenter: "Presenter",
      microphoneOn: "Microphone on",
      microphoneOff: "Microphone off"
    },
    participantsDock: {
      title: "Participants",
      close: "Close participants",
      closeError: "Could not confirm closing."
    },
    participantsPanel: {
      title: "Participants",
      refresh: "Refresh",
      empty: "No participants",
      waiting: "Waiting room",
      presenter: "Presenter",
      guest: "Participant",
      music: "Music from the sorcerer",
      audio: "Microphone on",
      muted: "Microphone off",
      video: "Camera on",
      screen: "Sharing screen",
      error: "The participant list could not be verified.",
      unavailable: "No active meeting session.",
      actionError: "The action was rejected or could not be confirmed.",
      search: "Search participants",
      privateChat: "Private chat",
      roleGrant: "Make presenter",
      roleRevoke: "Remove presenter role",
      mute: "Mute microphone",
      hide: "Turn camera off",
      stop: "Stop screen sharing",
      ban: "Ban for 24 hours",
      eject: "Kick",
      pin: "Focus",
      hideGrid: "Hide from grid",
      showGrid: "Show in grid",
      accept: "Admit",
      reject: "Reject",
      acceptAll: "Admit all",
      rejectAll: "Reject all",
      volume: "Volume",
      actions: "Actions",
      invite: "Invite",
      roomActions: "Room actions",
      muteAll: "Mute everyone",
      hideAll: "Turn off every camera",
      stopAll: "Stop all screen sharing",
      disconnectAll: "Disconnect all participants",
      you: "you",
      videoOff: "Camera off",
      screenOff: "Not sharing screen"
    },
    cameraEffects: { title: "Effect", off: "No effect", low: "Light blur", high: "Strong blur", unsupported: "Effects are not available in this browser." },
    cameraQuickMenu: {
      cameras: "Cameras",
      open: "Open video settings"
    },
    cardActions: {
      region: "Meeting participants",
      focus: "Focus",
      unfocus: "Back to grid",
      fullscreen: "Full screen",
      exitFullscreen: "Exit full screen",
      pip: "Picture in picture",
      more: "Actions",
      volume: "Volume",
      privateChat: "Private message",
      hide: "Hide from grid",
      mute: "Mute microphone",
      hideCamera: "Turn off camera",
      stopScreen: "Stop screen share",
      makePresenter: "Make presenter",
      removePresenter: "Remove presenter role",
      eject: "Kick",
      ban: "Ban for 24 hours"
    },
    confirmDialog: {
      ban: {
        title: "Ban this participant?",
        body: "{name} will not be able to return to this room for 24 hours.",
        confirm: "Ban"
      },
      cancel: "Cancel"
    },
    meetingControlBar: {
      controls: "Meeting controls",
      accessDenied: "Access not granted",
      mute: "Mute microphone",
      unmute: "Unmute microphone",
      micDevices: "Choose microphone and output device",
      cameraOff: "Turn camera off",
      cameraOn: "Turn camera on",
      cameraDevices: "Choose camera",
      screenOn: "Share screen",
      screenOff: "Stop sharing",
      chat: "Chat",
      participants: "Participants",
      settings: "Settings",
      more: "More",
      invite: "Share room",
      about: "About",
      leave: "Leave meeting",
      microphone: "Microphone",
      speaker: "Output device",
      camera: "Camera",
      holdToTalk: "Hold to talk (Space)"
    },
    meetingPrejoin: {
      title: "Bodrik FM meeting",
      name: "Enter your name",
      join: "Join meeting",
      micOn: "Microphone on",
      micOff: "Microphone off",
      camOn: "Camera on",
      camOff: "Camera off",
      camera: "Camera",
      microphone: "Microphone",
      audioDevice: "Audio device",
      routeHint: "Selection changes the microphone and output device together.",
      speaker: "Output device",
      avatar: "Upload avatar",
      avatarInvalid: "Use a PNG, JPEG or WebP image up to 10 MB.",
      profiles: "Join as",
      newProfile: "New",
      removeProfile: "Remove profile"
    },
    meetingRoom: {
      reconnecting: "Reconnecting…",
      failed: "Could not restore the connection.",
      left: "You left the meeting.",
      kicked: "The presenter kicked you from the meeting.",
      banned: "You were banned from this room.",
      lobby: "Waiting in the lobby…"
    },
    meetingStatusCopy: {
      home: "Bodrik FM home",
      connecting: "Connecting…",
      retry: "Try again",
      rejoin: "Rejoin the meeting",
      takeBack: "Connect here",
      passwordLabel: "Password",
      submit: "Enter",
      wrongPassword: "That password didn't work. Try again.",
      left: {
        title: "See you!",
        description: "You've left. You're welcome to come back.",
        action: "rejoin"
      },
      failed: {
        title: "Couldn't connect",
        description: "Shall we try again?",
        action: "retry"
      },
      unavailable: {
        title: "Meeting unavailable",
        description: "The room is missing or the meeting is closed. Check the link with the presenter."
      },
      denied: {
        title: "Couldn't join",
        description: "Check with the presenter whether you can join."
      },
      kicked: {
        title: "The presenter ended your participation",
        description: "You're no longer in the meeting."
      },
      banned: {
        title: "Entry temporarily blocked",
        description: "The presenter blocked your access for 24 hours."
      },
      rejected: {
        title: "You weren't let in",
        description: "The presenter declined your request to join."
      },
      removed: {
        title: "You're no longer in the meeting",
        description: "Your participation has ended."
      },
      replaced: {
        title: "Meeting open elsewhere",
        description: "You connected in another tab or on another device.",
        action: "takeBack"
      },
      lobby: {
        title: "Starting soon",
        description: "Waiting for the presenter to let you in."
      },
      password: {
        title: "Password needed",
        description: "Ask the presenter for it."
      },
      joinLocked: {
        title: "Room closed to new arrivals",
        description: "The presenter isn't accepting new participants right now."
      },
      connectingPage: {
        title: "Connecting…",
        description: "Establishing a connection to the meeting.",
        action: "retry"
      }
    },
    micQuickMenu: {
      microphones: "Microphones",
      audioDevice: "Audio device",
      routeHint: "Selection changes the microphone and output device together.",
      processing: "Microphone settings",
      noise: "Noise suppression",
      off: "Off",
      browser: "Browser",
      enhanced: "Smart",
      maximum: "Studio",
      echo: "Echo cancellation",
      gain: "Auto gain control",
      ptt: "Push to talk",
      speakers: "Output device",
      volume: "Output volume",
      test: "Test output device",
      stopTest: "Stop",
      open: "Open audio settings",
      unavailable: "Unavailable",
      level: "Microphone level"
    },
    shareDialog: {
      title: "Share room",
      link: "Invitation link",
      copy: "Copy link",
      copied: "Link copied",
      close: "Close"
    },
    audioSettings: {
      title: "Audio",
      intro: "Select your microphone and output device, then adjust meeting audio.",
      mic: "Microphone",
      audioDevice: "Audio device",
      routeHint: "Selection changes the microphone and output device together.",
      speaker: "Output device",
      noise: "Noise suppression",
      off: "Off",
      browser: "Browser",
      enhanced: "Smart",
      maximum: "Studio",
      noiseHelp: [
        "Off: your mic sends everything as is, background included.",
        "Browser: your browser softens background noise a little. Enough for a quiet room.",
        "Smart: removes steady background noise like a computer hum, a fan or traffic outside. Barely loads your device.",
        "Studio: removes both steady background noise and sudden sounds like typing, mouse clicks or a barking dog. Your voice stays natural. Uses more of your device.",
      ],
      help: "Help",
      test: "Test",
      stopTest: "Stop",
      ptt: "Push to talk",
      focus: "Speaker focus",
      focusHelp: "Highlights the participant who is currently speaking.",
      empty: "No devices found",
      level: "Microphone level",
      systemOutput: "This browser does not expose audio output selection. Choose speakers or Bluetooth headphones in your device’s sound settings.",
      processingError: "Could not update audio settings. Please try again."
    },
    micProcessingSettings: {
      section: "Microphone processing",
      help: "Help",
      echo: "Echo cancellation",
      echoHelp: "Reduces speaker audio picked up by the microphone.",
      gain: "Automatic gain control",
      gainHelp: "Automatically adjusts microphone volume.",
      enabled: "on",
      disabled: "off",
      effective: "Currently applied: ",
      error: "Could not update audio settings. Please try again."
    },
    personalSettings: {
      layout: "Video layout",
      shortcuts: "Keyboard shortcuts",
      language: "Language",
      enabled: "Keyboard shortcuts",
      participantView: "Participant view",
      pinPosition: "Pinned video position",
      buttonsBar: "Buttons bar",
      aspectRatio: "Aspect ratio",
      objectFit: "Video cropping",
      videoControls: "Video controls",
      error: "Could not update the setting. Please try again.",
      actions: ["Microphone", "Camera", "Screen share", "Chat", "Settings"]
    },
    policySettings: {
      room: "Room access",
      moderator: "Participant permissions",
      lobby: "Waiting room",
      joinLock: "Lock room for new participants",
      password: "Room password",
      lock: "Set password",
      unlock: "Remove password",
      passwordPlaceholder: "New password",
      locked: "Password is set",
      presenter: "Only the presenter can change these settings.",
      error: "The server did not confirm the policy change.",
      unknown: "The outcome is unknown. Check room state before trying again.",
      storage: "The server applied the policy, but local persistence failed.",
      audio_start_muted: "Participants start muted",
      video_start_hidden: "Participants start with camera off",
      audio_cant_unmute: "Prevent microphone activation",
      video_cant_unhide: "Prevent camera activation",
      screen_cant_share: "Prevent screen sharing",
      chat_cant_privately: "Prevent private messages",
      chat_cant_publicly: "Prevent public messages",
      bans: "Banned participants",
      bansEmpty: "Nobody is banned.",
      unban: "Unban",
      hoursLeft: "{n} h left",
      minutesLeft: "{n} min left",
      bansNote: "Bans last 24 hours and reset when the server restarts."
    },
    profileSettings: {
      title: "Your profile",
      intro: "Change your name and avatar for the meeting.",
      name: "Username",
      save: "Save",
      upload: "Change avatar",
      reset: "Remove",
      resetLabel: "Remove avatar",
      presenter: "Presenter",
      participant: "Participant",
      details: "Technical details",
      browser: "Browser",
      cpu: "CPU info",
      device: "Device",
      engine: "Engine",
      os: "OS info",
      error: "Could not update your profile. Check the name or image and try again."
    },
    roomInfo: {
      title: "Room settings",
      intro: "Manage access, invitations and your room preferences.",
      share: "Share room",
      time: "Time in meeting"
    },
    settingsShell: {
      title: "Meeting settings",
      close: "Close settings",
      devices: "Devices",
      meeting: "Meeting",
      tabAudioDevices: "Audio",
      tabVideoDevices: "Video",
      tabProfile: "Profile",
      tabRoom: "Room",
      tabModerator: "Moderator",
      tabShortcuts: "Shortcuts",
      tabLanguages: "Language"
    },
    speakerVolumeSettings: {
      label: "Output volume",
      help: "Help",
      description: "Meeting volume for you: participants and music. Does not change microphone gain or other participants’ settings.",
      error: "Could not apply or save output volume. Please try again."
    },
    videoSettings: {
      title: "Video",
      intro: "Choose your camera and balance image quality with performance.",
      camera: "Camera",
      quality: "Video quality",
      fps: "Camera FPS",
      screenQuality: "Screen quality",
      screenFps: "Screen FPS",
      screenHint: "Screen optimization",
      empty: "No cameras found",
      access: "Request camera access",
      error: "Could not apply video settings. Check camera access or lower the quality."
    },
};
