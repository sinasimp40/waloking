====================================
  BRANDING FOLDER - HOW TO USE
====================================

PER-CUSTOMER LOGOS (multi-customer setups):
   When you have more than one customer in customers/, each customer's
   logo MUST live at:

       branding/<channel>-logo.<ext>

   where <channel> matches the "channel" field in customers/<channel>.json
   and <ext> is png, jpg, jpeg, jfif, or webp.

   Example: customers/example-cafe.json -> branding/example-cafe-logo.png

   The build script reads ONLY this exact filename for each customer. It
   will hard-fail (and skip that one customer in build-all) if the file is
   missing — this is intentional, to prevent the historic "every customer
   got customer-A's logo" leakage bug from ever returning.

SINGLE-LOGO MODE (legacy / one-off rebrand):
1. Drop your logo image here (PNG, JPG, JPEG, JFIF, or WEBP)
   - Any of these image formats works (NOT ICO)
   - The build script will auto-convert it to ICO
   - Only put ONE image file here

2. Run build.bat from the project root folder

3. The script will ask you for:
   - App Name (e.g. "NEXTREME GAMING HUB")
   - Subtitle (e.g. "Internet Cafe")

4. It will automatically:
   - Rename everything in the launcher and server
   - Convert your image to ICO for both apps
   - Build both installer .exe files

NOTES:
- config.json stores the current brand settings
- Do NOT edit config.json manually
- Admin password stays DENFI2024 (changeable in app)
