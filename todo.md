Week of Aug 5

- npm install firebase

// src/firebase.js
import { initializeApp } from "firebase/app";
import { getFirestore } from "firebase/firestore";

// Replace this object with your actual Firebase project config snippet
const firebaseConfig = {
  apiKey: "YOUR_API_KEY",
  authDomain: "YOUR_PROJECT_://firebaseapp.com",
  projectId: "YOUR_PROJECT_ID",
  storageBucket: "YOUR_PROJECT_://appspot.com",
  messagingSenderId: "YOUR_MESSAGING_SENDER_ID",
  appId: "YOUR_APP_ID"
};

// Initialize Firebase App
const app = initializeApp(firebaseConfig);

// Initialize Firestore and export it for use across your application
export const db = getFirestore(app);


export default function ItemList() {
  const [items, setItems] = useState([]);
  const [projects, setProjects] = useState([]);
  const [music, setMusic] = useState([]);

  useEffect(() => {
    const fetchItems = async () => {
      // Reference your target collection name
      const querySnapshot = await getDocs(collection(db, "products")); # Probably not called products. Probably called "projects"
      const data = querySnapshot.docs.map(doc => ({
        id: doc.id,
        ...doc.data()
      }));
      setItems(data);
    };

    fetchItems();
  }, []);

  return (
    <ul>
      {items.map(item => <li key={item.id}>{item.name}</li>)}
    </ul>
  );
}



Week of July 15

- Adjust model weights

model_output, midi_data, note_events = predict(
        temp_path,
        ICASSP_2022_MODEL_PATH,
        # EXAMPLE: onset_threshold=0.6,      # higher = fewer but more confident onsets
        frame_threshold ->  lower = catches quieter notes
        minimum_note_length -> filters pick noise and string artifacts
        minimum_frequency ->  low E2 — lowest note on standard guitar
        maximum_frequency -> high E6 — highest note on standard guitar
        melodia_trick = True -> cleans up ghost notes between real onsets
    )

- Create backend folder

- Use FigmaAI to start designing the look of your frontend
- Try to add all the elements of your frontend to the react

Spectrogram

Week of June 17
librosa.stft #https://librosa.org/doc/main/generated/librosa.stft.html
librosa.amplitude_to_db
librosa.frames_to_time

Week of june 24
Look at Crepe pitch tracking

torch, torchcrepe
torchcrepe.predict()

.squeeze(), 

PROBLEM TO TACKLE:

- Right now, we are printing out all the times on to the spectrogram. We just want to use the onset times. librosa has a helpful function for this: librosa.onset.onset_detect(). THis would be before librosa.frames_to_time