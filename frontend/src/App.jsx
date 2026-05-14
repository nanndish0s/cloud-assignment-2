import React, { useState, useEffect } from 'react';
import axios from 'axios';
import { Plane, Luggage, User, CheckCircle, Bell, Lock, Mail } from 'lucide-react';

const API_BASE = 'http://localhost:3000';

function App() {
  const [flights, setFlights] = useState([]);
  const [bookingStatus, setBookingStatus] = useState(null);
  const [loading, setLoading] = useState(false);

  // Auth State
  const [isLoggedIn, setIsLoggedIn] = useState(false);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [token, setToken] = useState(localStorage.getItem('token') || '');
  const [authMode, setAuthMode] = useState('login'); // 'login' or 'register'

  const [baggage, setBaggage] = useState(null);

  useEffect(() => {
    if (token) {
      setIsLoggedIn(true);
      fetchFlights();
      fetchBaggage(); // Add this
    }
  }, [token]);

  const fetchFlights = async () => {
    try {
      const res = await axios.get(`${API_BASE}/flights`);
      setFlights(res.data);
    } catch (error) {
      console.error('Failed to fetch flights');
    }
  };

  const handleAuth = async (e) => {
    e.preventDefault();
    setLoading(true);
    try {
      const endpoint = authMode === 'login' ? '/auth/login' : '/auth/register';
      const res = await axios.post(`${API_BASE}${endpoint}`, { email, password });

      if (authMode === 'login') {
        const newToken = res.data.token;
        setToken(newToken);
        localStorage.setItem('token', newToken);
        setIsLoggedIn(true);
        fetchFlights();
      } else {
        alert('Registration successful! Please login.');
        setAuthMode('login');
      }
    } catch (error) {
      alert(error.response?.data?.error || 'Authentication failed');
    } finally {
      setLoading(false);
    }
  };

  const handleLogout = () => {
    setToken('');
    localStorage.removeItem('token');
    setIsLoggedIn(false);
  };

  const fetchBaggage = async () => {
    try {
      // The BaggageId is BAG-BK-XXXX
      // For now, let's just try to find any baggage for this user
      // In a real app, we'd store the booking ID in state
      const res = await axios.get(`${API_BASE}/baggage/BAG-${email}`, {
        headers: { Authorization: `Bearer ${token}` }
      });
      setBaggage(res.data);
    } catch (error) {
      console.log('No baggage found yet');
    }
  };

  const handleBooking = async (flightId) => {
    setLoading(true);
    try {
      const res = await axios.post(`${API_BASE}/bookings`,
        { flightId, passengerEmail: email },
        { headers: { Authorization: `Bearer ${token}` } }
      );

      const bid = res.data.bookingId;
      setBookingStatus(`Successfully booked flight ${flightId}! (Booking ID: ${bid})`);

      // Immediately check for baggage after 2 seconds (to let Kafka finish)
      setTimeout(() => fetchBaggageById(bid), 2000);

      setTimeout(() => setBookingStatus(null), 5000);
      fetchFlights();
    } catch (error) {
      alert(error.response?.data?.error || 'Booking failed');
    } finally {
      setLoading(false);
    }
  };

  const fetchBaggageById = async (bookingId) => {
    try {
      const res = await axios.get(`${API_BASE}/baggage/BAG-${bookingId}`, {
        headers: { Authorization: `Bearer ${token}` }
      });
      setBaggage(res.data);
    } catch (error) {
      console.error('Baggage not found');
    }
  };

  if (!isLoggedIn) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-gradient-to-br from-slate-900 via-slate-800 to-slate-900 p-4">
        <div className="glass p-8 w-full max-w-md animate-fade-in">
          <div className="flex flex-col items-center mb-8">
            <Plane className="w-12 h-12 text-primary-400 mb-2" />
            <h1 className="text-2xl font-bold text-white">AeroLink Platform</h1>
            <p className="text-slate-400 text-sm mt-2">Transitioning to Cloud-Native</p>
          </div>

          <form onSubmit={handleAuth} className="space-y-4">
            <div className="relative">
              <Mail className="absolute left-3 top-3 w-5 h-5 text-slate-500" />
              <input
                type="email"
                placeholder="Email Address"
                className="w-full bg-white/5 border border-white/10 rounded-lg py-2.5 pl-10 pr-4 text-white focus:outline-none focus:ring-2 focus:ring-primary-500"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                required
              />
            </div>
            <div className="relative">
              <Lock className="absolute left-3 top-3 w-5 h-5 text-slate-500" />
              <input
                type="password"
                placeholder="Password"
                className="w-full bg-white/5 border border-white/10 rounded-lg py-2.5 pl-10 pr-4 text-white focus:outline-none focus:ring-2 focus:ring-primary-500"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                required
              />
            </div>
            <button type="submit" disabled={loading} className="w-full btn-primary py-3">
              {loading ? 'Processing...' : (authMode === 'login' ? 'Sign In' : 'Create Account')}
            </button>
          </form>

          <div className="mt-6 text-center text-sm text-slate-400">
            {authMode === 'login' ? (
              <p>Don't have an account? <button onClick={() => setAuthMode('register')} className="text-primary-400 hover:underline">Register here</button></p>
            ) : (
              <p>Already have an account? <button onClick={() => setAuthMode('login')} className="text-primary-400 hover:underline">Login here</button></p>
            )}
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen p-8 bg-gradient-to-br from-slate-900 via-slate-800 to-slate-900">
      <header className="flex justify-between items-center mb-12">
        <div className="flex items-center gap-3">
          <Plane className="w-10 h-10 text-primary-400" />
          <h1 className="text-3xl font-bold tracking-tight text-white">AeroLink <span className="text-primary-500">Systems</span></h1>
        </div>
        <div className="flex gap-4">
          <div className="flex items-center gap-2 glass px-4 py-2">
            <User className="w-5 h-5 text-primary-400" />
            <span className="text-sm font-medium">{email}</span>
            <button onClick={handleLogout} className="ml-2 text-xs text-red-400 hover:text-red-300">Logout</button>
          </div>
        </div>
      </header>

      {bookingStatus && (
        <div className="mb-8 p-4 bg-green-500/20 border border-green-500/50 rounded-lg flex items-center gap-3 text-green-300">
          <CheckCircle className="w-5 h-5" />
          {bookingStatus}
        </div>
      )}

      <main className="grid grid-cols-1 lg:grid-cols-3 gap-8">
        <div className="lg:col-span-2 space-y-6">
          <h2 className="text-xl font-semibold text-slate-300 flex items-center gap-2">
            <Plane className="w-5 h-5" /> Available Flights
          </h2>
          <div className="grid gap-4">
            {flights.map(flight => (
              <div key={flight.id} className="glass p-6 flex justify-between items-center hover:bg-white/15 transition-all">
                <div>
                  <div className="text-2xl font-bold text-white mb-1">{flight.origin} → {flight.destination}</div>
                  <div className="text-sm text-slate-400 font-mono">{flight.id}</div>
                </div>
                <div className="text-right">
                  <div className="text-2xl font-bold text-primary-400 mb-2">{flight.price}</div>
                  <div className="text-sm text-slate-400 mb-4">{flight.seats} seats remaining</div>
                  <button
                    onClick={() => handleBooking(flight.id)}
                    disabled={loading}
                    className="btn-primary"
                  >
                    {loading ? 'Booking...' : 'Book Now'}
                  </button>
                </div>
              </div>
            ))}
          </div>
        </div>

        <div className="space-y-8">
          <section className="glass p-6">
            <h3 className="text-lg font-semibold text-slate-200 mb-4 flex items-center gap-2">
              <Luggage className="w-5 h-5 text-primary-400" /> Baggage Status
            </h3>
            <div className="space-y-4 text-sm text-slate-400">
              {baggage ? (
                <div className="space-y-3">
                  <div className="p-3 bg-white/5 rounded-lg border border-white/5">
                    <div className="text-xs text-slate-500 uppercase tracking-wider mb-1">Baggage ID</div>
                    <div className="text-sm text-white font-mono">{baggage.BaggageId}</div>
                  </div>
                  <div className="p-3 bg-white/5 rounded-lg border border-white/5">
                    <div className="text-xs text-slate-500 uppercase tracking-wider mb-1">Status</div>
                    <div className="text-sm text-green-400 font-bold">{baggage.Status}</div>
                  </div>
                  <div className="p-3 bg-white/5 rounded-lg border border-white/5">
                    <div className="text-xs text-slate-500 uppercase tracking-wider mb-1">Last Update</div>
                    <div className="text-sm text-slate-300">{new Date(baggage.LastUpdate).toLocaleString()}</div>
                  </div>
                </div>
              ) : (
                <p>Your baggage will automatically appear here once a booking is confirmed.</p>
              )}
            </div>
          </section>

          <section className="glass p-6">
            <h3 className="text-lg font-semibold text-slate-200 mb-4 flex items-center gap-2">
              <Bell className="w-5 h-5 text-primary-400" /> System Status
            </h3>
            <div className="space-y-2 text-xs text-slate-400">
              <div className="flex justify-between">
                <span>API Gateway (Port 3000)</span>
                <span className="text-green-400">ONLINE</span>
              </div>
              <div className="flex justify-between">
                <span>Auth Service (JWT/bcrypt)</span>
                <span className="text-green-400">READY</span>
              </div>
            </div>
          </section>
        </div>
      </main>
    </div>
  );
}

export default App;
