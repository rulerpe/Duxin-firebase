const functions = require("firebase-functions");
const { onRequest } = require("firebase-functions/v2/https");
const admin = require("firebase-admin");
const { getStorage } = require("firebase-admin/storage");
const { getFirestore, Timestamp } = require("firebase-admin/firestore");
const Anthropic = require("@anthropic-ai/sdk");
const anthropic = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY,
});
const languageCodeRef = require("./languageCodeRef.json");
const { onDocumentDeleted } = require("firebase-functions/v2/firestore");

const vision = require('@google-cloud/vision');
const translate = require('@google-cloud/translate').v2;
const { createCanvas, loadImage } = require('canvas');

const visionClient = new vision.ImageAnnotatorClient();
const translateClient = new translate.Translate();

admin.initializeApp();
const bucketName = "duxin-app.appspot.com";

exports.getSummaryTranslation = onRequest(
  {
    cors: ["http://localhost:8081", /duxinapp\.com$/],
  },
  async (req, res) => {
    // Check if this is a warm-up request from Cloud Scheduler
    if (req.headers["user-agent"] === "Google-Cloud-Scheduler") {
      console.log("Warm-up request received");
      // Immediately respond to warm-up request
      res.status(200).send("Warming up function.");
      return;
    }

    const idToken = req.headers.authorization?.split("Bearer ")[1];
    if (!idToken) {
      return res.status(403).send("Unauthorized");
    }
    const uploadImage = async (base64Image, imageName) => {
      const imageBuffer = Buffer.from(base64Image, "base64");
      const bucket = getStorage().bucket(bucketName);
      await bucket.file(imageName).save(imageBuffer);
      return;
    };

    const summarizeImage = async (base64Image, language) => {
      const result = await anthropic.messages.create({
        model: "claude-3-sonnet-20240229",
        max_tokens: 1024,
        messages: [
          {
            role: "user",
            content: [
              {
                type: "image",
                source: {
                  type: "base64",
                  media_type: "image/jpeg",
                  data: base64Image,
                },
              },
              {
                type: "text",
                text: `Based on the image content, please complete the following tasks:
                          1. Provide a title within 3 words that summarizes the image content.        
                          2. Summarize the main content of the image within 2 sentences.          
                          3. Provide action items within 1 sentence, suggesting what actions should be taken based on the image content.
                          Please respond to all three tasks in simplify ${language}. 
                          Use JSON format with the keys "title", "summary", and "action", keep the keys in English`,
              },
            ],
          },
          {
            role: "assistant",
            content: "{",
          },
        ],
      });
      return result;
    };

    try {
      const decodedToken = await admin.auth().verifyIdToken(idToken);
      const uid = decodedToken.uid;
      const base64Image = req.body.data.image;
      const imageName = `images/${uid}/${Date.now()}.jpg`;
      const language = languageCodeRef[req.body.data.language];

      const [uploadResult, summarizeResult] = await Promise.all([
        uploadImage(base64Image, imageName),
        summarizeImage(base64Image, language),
      ]);

      const contentJson = JSON.parse(`{${summarizeResult.content[0].text}`);

      const db = getFirestore();
      const summarydata = {
        createdAt: Timestamp.fromDate(new Date()),
        language: language,
        userId: uid,
        summaryAction: contentJson.action,
        summaryBody: contentJson.summary,
        summaryTitle: contentJson.title,
        imageName: imageName,
        tokenUsed: JSON.stringify(summarizeResult.usage),
      };
      await db.collection("summaries").add(summarydata);

      res.status(200).send({ data: summarydata });
    } catch (error) {
      console.error("Server Error:", error);
      res.status(404).send("ServerError");
    }
  }
);

exports.deleteSummaryImage = onDocumentDeleted(
  "summaries/{summaryId}",
  async (event) => {
    const snap = event.data;
    const data = snap.data();
    const bucket = getStorage().bucket(bucketName);
    const file = bucket.file(data.imageName);
    try {
      await file.delete();
      console.log(`Successfully deleted file at ${data.imageName}`);
    } catch (error) {
      console.error(`Failed to delete file at ${data.imageName}`, error);
    }
  }
);

exports.cleanupUserData = functions.auth.user().onDelete(async (user) => {
  const userId = user.uid;
  const db = admin.firestore();

  await db.collection("users").doc(userId).delete();
  console.log(`Deleted user metadata for userId: ${userId}`);

  const summariesRef = db.collection("summaries").where("userId", "==", userId);
  const snapshots = await summariesRef.get();

  if (!snapshots.empty) {
    const batch = db.batch();
    const promises = [];
    snapshots.forEach((doc) => {
      batch.delete(doc.ref);
      const summary = doc.data();
      if (summary.imageName) {
        const bucket = getStorage().bucket(bucketName);
        const fileRef = bucket.file(summary.imageName);
        promises.push(
          fileRef.delete().catch((error) => {
            console.error(
              `Failed to delete file at path: ${summary.filePath}`,
              error
            );
          })
        );
      }
    });
    promises.push(batch.commit());
    await Promise.all(promises);
    console.log(`Deleted all text summaries related to user: ${userId}`);
  } else {
    console.log(`No summaries found for user: ${userId}`);
  }
});


function wrapText(ctx, text, maxWidth) {
  const words = [];
  let line = '';
  let lines = [];

  for (let i = 0; i < text.length; i++) {
    const char = text[i]
    const testLine = line + char;
    const metrics = ctx.measureText(testLine);
    const testWidth = metrics.width;

    if (testWidth > maxWidth && i > 0) {
      lines.push(line);
      line = char;
    } else {
      line = testLine;
    }
  }
  if (line.length > 0) {
    lines.push(line);
  }
  return lines;
}

exports.documentTranslate = onRequest(
  {
    
    cors: ["http://localhost:8081", /duxinapp\.com$/],
  },
  async (req, res) =>{
    const imageName = req.body.data.imageName;
    const bucket = getStorage().bucket(bucketName);
    const file = bucket.file(imageName);
    const [imageBuffer] = await file.download()

    const pargraphArr = []
    // Perform OCR on the image
    // visionClient.documentTextDetection
    const [result] = await visionClient.documentTextDetection(imageBuffer);

    const document = result.fullTextAnnotation
    for (const page of document.pages){
      for (const block of page.blocks){
        for (const pargraph of block.paragraphs){
          let wordsArr = []
          let wordBoundingBox = pargraph.words[0].symbols[0].boundingBox
          let wordHeight = wordBoundingBox.vertices[2].y - wordBoundingBox.vertices[0].y
          for (const word of pargraph.words){
            let wordStr = ''
            for (const symbol of word.symbols){
              wordStr+=symbol.text
            }
            wordsArr.push(wordStr)
          }
          let pargraphObj = {
            text: wordsArr.join(' '),
            boundingBox: pargraph.boundingBox,
            wordHeight
          }
          pargraphArr.push(pargraphObj)
        }

      }

    }

    // res.status(200).send({
    //   // pageArr: pageArr,
    //   // blockArr: blockArr,
    //   pargraphArr: pargraphArr,
    //   // wordArr: wordArr,
    //   // symbolArr:symbolArr
    //   textAnnotations:textAnnotations
    // })
    // return
    // const textBlocks = result.fullTextAnnotation.pages[0].blocks;
  
    // Translate the extracted text
    const pargraphText = pargraphArr.map((pargraph) => pargraph.text).join('\n');
    
    const target = 'zh'; // Replace with the desired target language code
    const [translation] = await translateClient.translate(pargraphText, target);
    const translatedPargraphs = translation.split('\n'); 

    // Load the original image
    const image = await loadImage(imageBuffer);

    // Create a new canvas and draw the original image
    const canvas = createCanvas(image.width, image.height);
    const ctx = canvas.getContext('2d');
    ctx.drawImage(image, 0, 0);

    // Replace text blocks on the image
    const font = '16px Arial';
    ctx.font = font;
    pargraphArr.forEach((pargraph, i) => {
      const translatedText = translatedPargraphs[i];
      const [x1, y1] = [pargraph.boundingBox.vertices[0].x, pargraph.boundingBox.vertices[0].y];
      const [x2, y2] = [pargraph.boundingBox.vertices[2].x, pargraph.boundingBox.vertices[2].y];
      const boxWidth = x2 - x1;
      const boxHeight = y2 - y1;
      // const textWidth = ctx.measureText(translatedText).width;
      // const textHeight = parseInt(font, 10);

      // Adjust font size to fit the text within the bounding box
      // let fontSize = parseInt(font, 10);
      ctx.font = `${pargraph.wordHeight}px Arial`;
      const textHeight = parseInt(font, 10);
      // let textHeight = fontSize;

      // while (textHeight > boxHeight) {
      //   fontSize -= 1;
      //   ctx.font = `${fontSize}px Arial`;
      //   textHeight = fontSize;
      // }
      // Wrap the text to fit within the bounding box
      const lines = wrapText(ctx, translatedText, boxWidth);
      console.log('translatedText',translatedText)
      console.log('lines',lines)
      ctx.fillStyle = 'white';
      ctx.fillRect(x1, y1, boxWidth, boxHeight);
      ctx.fillStyle = 'black';

      let lineY = y1 + textHeight;
      for (const line of lines) {
        if (lineY + textHeight > y2) break;
        ctx.fillText(line, x1, lineY);
        lineY += textHeight;
      }
    });

    // Convert the canvas to a buffer and return it as the response
    const translatedImageBuffer = canvas.toBuffer('image/jpeg');
    const uploadImage = async (base64Image, imagePath) => {
      const imageBuffer = Buffer.from(base64Image, "base64");
      const bucket = getStorage().bucket(bucketName);
      await bucket.file(imagePath).save(imageBuffer);
      return;
    };
    await uploadImage(translatedImageBuffer,`translated-${imageName}`)
    
    res.status(200).send(translatedImageBuffer);
    
  }
)