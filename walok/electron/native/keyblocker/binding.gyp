{
  "targets": [
    {
      "target_name": "keyblocker",
      "sources": [ "src/keyblocker.cc" ],
      "include_dirs": [
        "<!@(node -p \"require('node-addon-api').include\")"
      ],
      "dependencies": [
        "<!(node -p \"require('node-addon-api').gyp\")"
      ],
      "defines": [ "NAPI_DISABLE_CPP_EXCEPTIONS" ],
      "conditions": [
        [ "OS=='win'", {
          "libraries": [ "-luser32.lib" ],
          "msvs_settings": {
            "VCCLCompilerTool": { "ExceptionHandling": 1 }
          }
        }],
        [ "OS!='win'", {
          "sources!": [ "src/keyblocker.cc" ],
          "sources": [ "src/keyblocker_stub.cc" ]
        }]
      ]
    }
  ]
}
