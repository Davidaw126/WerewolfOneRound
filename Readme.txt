0. You will need MongoDB, python
1. Make sure you are in command prompt, not windows power shell
2. Create a virtual environment: python3 -m venv venv
3. Install all required library: pip install -r requirements.txt
4. Activate the environment: venv/Scripts/activate
5. Run following command:
    set FLASK_APP=server.py
    set FLASK_ENV=development
    flask run --host=192.168.1.205



Save requirements
python -m pip freeze > requirements.txt

